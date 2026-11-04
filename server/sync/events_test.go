package sync

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/zakirullin/files.md/server/config"
)

func eventsFixture(t *testing.T) string {
	t.Helper()
	notesFixture(t)
	oldConfig, oldSubscribe := config.ServerCfg, SubscribeNoteChanges
	t.Cleanup(func() { config.ServerCfg, SubscribeNoteChanges = oldConfig, oldSubscribe })
	config.ServerCfg.RequireSafeSync = true
	config.ServerCfg.TokensDir = t.TempDir()
	token := "test-events-token"
	require.NoError(t, os.WriteFile(filepath.Join(config.ServerCfg.TokensDir, hashToken(token)), []byte("1"), 0600))
	return token
}

func TestNotesEventsRejectUnauthenticatedAndOldClients(t *testing.T) {
	token := eventsFixture(t)
	for _, tc := range []struct {
		method, token, version string
		want                   int
	}{
		{http.MethodPost, token, "3", 405},
		{http.MethodGet, token, "2", 409},
		{http.MethodGet, "bad-token", "3", 401},
		{http.MethodGet, "", "3", 401},
		{http.MethodGet, token, "3", 503}, // Polling remains available without a watcher.
	} {
		t.Run(fmt.Sprintf("%s-%d", tc.method, tc.want), func(t *testing.T) {
			SubscribeNoteChanges = nil
			r := httptest.NewRequest(tc.method, "/notes/events", nil)
			r.Header.Set("X-FilesMD-Sync", tc.version)
			r.Header.Set("Authorization", tc.token)
			w := httptest.NewRecorder()
			NotesEvents(w, r)
			require.Equal(t, tc.want, w.Code)
		})
	}
}

// flushCapture lets tests exercise long-lived responses without opening a port.
type flushCapture struct {
	header  http.Header
	mu      stdsync.Mutex
	body    strings.Builder
	flushed chan struct{}
}

func (w *flushCapture) Header() http.Header { return w.header }
func (w *flushCapture) WriteHeader(int)     {}
func (w *flushCapture) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.body.Write(b)
}
func (w *flushCapture) Flush() {
	select {
	case w.flushed <- struct{}{}:
	default:
	}
}
func (w *flushCapture) text() string { w.mu.Lock(); defer w.mu.Unlock(); return w.body.String() }

func TestNotesEventsStreamDoesNotBlockSavesAndUnsubscribes(t *testing.T) {
	token := eventsFixture(t)
	changes := make(chan struct{}, 1)
	unsubscribed := make(chan struct{})
	SubscribeNoteChanges = func(userID int64) (<-chan struct{}, func(), error) {
		if userID != 1 {
			return nil, nil, fmt.Errorf("wrong user")
		}
		changes <- struct{}{}
		return changes, func() { close(unsubscribed) }, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, "/notes/events", nil).WithContext(ctx)
	r.Header.Set("X-FilesMD-Sync", "3")
	r.Header.Set("Accept-Encoding", "gzip")
	r.AddCookie(&http.Cookie{Name: AuthCookieName, Value: token})
	w := &flushCapture{header: make(http.Header), flushed: make(chan struct{}, 10)}
	done := make(chan struct{})
	// If streaming accidentally uses tokenMiddleware, it would hang here.
	safeSyncMu.Lock()
	go func() { router(log.New(io.Discard, "", 0)).ServeHTTP(w, r); close(done) }()
	select {
	case <-w.flushed:
		safeSyncMu.Unlock()
	case <-time.After(2 * time.Second):
		safeSyncMu.Unlock()
		cancel()
		<-done
		t.Fatal("stream is blocked by the save mutex")
	}
	require.Eventually(t, func() bool { return strings.Contains(w.text(), "event: change\ndata: {}\n\n") }, time.Second, time.Millisecond)
	changes <- struct{}{}
	require.Eventually(t, func() bool { return strings.Count(w.text(), "event: change") == 2 }, time.Second, time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stream ignored disconnect")
	}
	require.Equal(t, "text/event-stream", w.header.Get("Content-Type"))
	require.Empty(t, w.header.Get("Content-Encoding"), "gzip would buffer live events")
	select {
	case <-unsubscribed:
	default:
		t.Fatal("subscriber leaked after disconnect")
	}
}

func TestNotesEventsRejectUnknownSubscriber(t *testing.T) {
	token := eventsFixture(t)
	SubscribeNoteChanges = func(int64) (<-chan struct{}, func(), error) { return nil, nil, fmt.Errorf("unknown local user") }
	r := httptest.NewRequest(http.MethodGet, "/notes/events", nil)
	r.Header.Set("Authorization", token)
	r.Header.Set("X-FilesMD-Sync", "3")
	w := httptest.NewRecorder()
	NotesEvents(w, r)
	require.Equal(t, 503, w.Code)
}
