package sync

import (
	"fmt"
	"net/http"
	"time"

	"github.com/zakirullin/files.md/server/fs"
)

// SubscribeNoteChanges is configured by the local server before serving HTTP.
// Its notifications are hints to fetch a complete, versioned notes snapshot.
var SubscribeNoteChanges func(userID int64) (<-chan struct{}, func(), error)

// NotesEvents authenticates without holding safeSyncMu: a streaming reader must
// never prevent a save. No filenames, contents, or deletion operations are sent.
func NotesEvents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("X-FilesMD-Sync") != "3" {
		http.Error(w, "Reload the app to use current notes sync", http.StatusConflict)
		return
	}
	token := r.Header.Get("Authorization")
	if cookie, err := r.Cookie(AuthCookieName); err == nil && cookie.Value != "" {
		token = cookie.Value
	}
	userID, ok := findUserID(token)
	if !ok {
		// Expired streams are normal; do not IP-ban the browser's save requests.
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if SubscribeNoteChanges == nil {
		http.Error(w, "Live updates unavailable; continue polling", http.StatusServiceUnavailable)
		return
	}
	if _, err := fs.NewUserFS(userID); err != nil {
		http.Error(w, "Notes directory unavailable", http.StatusServiceUnavailable)
		return
	}
	changes, unsubscribe, err := SubscribeNoteChanges(userID)
	if err != nil {
		http.Error(w, "Live updates unavailable; continue polling", http.StatusServiceUnavailable)
		return
	}
	defer unsubscribe()
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	write := func(data string) bool {
		// Refresh the deadline per message, bounding slow-client resource use
		// while allowing streams beyond the server's ordinary write timeout.
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := fmt.Fprint(w, data); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	if !write("retry: 2000\n\n") {
		return
	}
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()
	// Reconnect periodically so revoked credentials cannot keep a stream alive.
	expires := time.NewTimer(5 * time.Minute)
	defer expires.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-expires.C:
			return
		case _, ok := <-changes:
			if !ok || !write("event: change\ndata: {}\n\n") {
				return
			}
		case <-heartbeat.C:
			if !write(": keepalive\n\n") {
				return
			}
		}
	}
}
