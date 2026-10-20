// TODO gzip
package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/zakirullin/files.md/server/config"
	"github.com/zakirullin/files.md/server/fs"
)

const (
	StatusOK              = "ok"
	StatusNotModified     = "notModified"
	StatusUpdatedOnServer = "updatedOnServer"
	StatusMerged          = "merged"

	MaxTextSize      = 5 << 20  // 5 MB
	MaxFilenamesSize = 10 << 20 // 10 MB
	MaxTokenSize     = 4 << 10  // 4 KB
)

var OnChatUpdate = func(userID int64) {}

type file struct {
	Status             string `json:"status"`
	Path               string `json:"path"`
	LastModified       int64  `json:"lastModified"`
	ClientLastModified int64  `json:"clientLastModified,omitempty"`
	ClientLastSynced   int64  `json:"clientLastSynced,omitempty"`
	Content            string `json:"content"`
}

type syncRequest struct {
	DeletedVersions map[string]int64 `json:"deletedVersions"`
	Modified        []file           `json:"modified"` // New or modified files from client
	Deleted         []string         `json:"deleted"`  // Deleted files from client
	Timestamps      map[string]int64 `json:"timestamps"`
	ServerTime      int64            `json:"serverTime"` // latest server-event ts the client has acknowledged; server returns events newer than this
}

type syncResponse struct {
	Status     string            `json:"status"`          // Status
	Error      string            `json:"error,omitempty"` // Server-side reason for a 4xx/5xx so the client can log it
	Files      []file            `json:"files"`           // Files with content that need syncing
	Timestamps map[string]int64  `json:"timestamps"`      // Current server timestamps in Unix format
	Renames    map[string]string `json:"renames"`         // What files to rename on client
	Deleted    map[string]int64  `json:"deleted"`         // path -> deletedAt; client drops local copies older than this
}

// SyncFilenames sync texts between client and server.
// The following steps are executed:
// 1) Save client-modified files to the server
// 2) In case of conflict (server has a newer modification), merge the files and include them in the response
// 3) Based on known client dirs timestamps, send newly updated or created files
// 4) Respond with last modification timestamps for every dir
func SyncFilenames(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(syncResponse{Status: "error", Error: "Method not allowed"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxFilenamesSize)

	var request syncRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(syncResponse{Status: "error", Error: fmt.Sprintf("Invalid syncFilenames JSON: %v", err)})
		return
	}

	userFS, err := fs.NewUserFS(userID(r))
	if err != nil {
		slog.Error("Sync error: syncTexts: error creating user FS", "error", err)
		http.Error(w, "Error creating user FS", http.StatusInternalServerError)
		return
	}

	// Validate every requested deletion before performing any mutation.
	if config.ServerCfg.RequireSafeSync {
		for _, path := range request.Deleted {
			current, err := userFS.Mtime(fs.DirUserRoot, strings.TrimPrefix(path, "/"))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			baseline := request.DeletedVersions[path]
			if err != nil || baseline == 0 || current != baseline {
				http.Error(w, "Deletion refused: file changed or explicit deletion baseline is missing", http.StatusConflict)
				return
			}
		}
	}

	// TODO using rename log first replace old paths in client request to new so other code will work okay
	// and maybe include it right away for files to send
	// TODO what if multiply moves, back and forth? Merge them?
	lastSync := int64(0)
	for _, ts := range request.Timestamps {
		if ts > lastSync {
			lastSync = ts
		}
	}
	// TODO if a file was changed on client on oldPath, merge it with the new path

	renames := make(map[string]string)
	// Don't respond renames on first sync
	if lastSync != 0 {
		renames = RenamesLog(userID(r), lastSync)
	}

	// Server-side events newer than the client's acknowledged watermark.
	deletes := DeletesLog(userID(r), request.ServerTime+1)

	// Suppress echoes: don't return entries that THIS client just told us
	// about in request.Deleted. Match by suffix so it works regardless of
	// whether DeletesLog keys are stripped or absolute.
	for _, p := range request.Deleted {
		ownRel := strings.TrimPrefix(strings.TrimPrefix(p, "/"), "/")
		for key := range deletes {
			if key == ownRel || strings.HasSuffix(key, "/"+ownRel) {
				delete(deletes, key)
			}
		}
	}

	// If a file was renamed and changed, on client we would rename then change?
	// Save client-modified files to the server
	for _, clientFile := range request.Modified {
		// Paths that are coming from client start with /, make them relative
		path := strings.TrimPrefix(clientFile.Path, "/")
		relativePath := strings.TrimPrefix(path, "/")

		serverModifiedTime, err := userFS.Mtime(fs.DirUserRoot, relativePath)
		var clientContent string
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Error("Sync error: syncTexts: error reading file", "path", path, "error", err)
			logSync(fmt.Sprintf("Sync texts: error reading file '%s': %v", path, err), r)
			http.Error(w, "Failed to read file; deletions not applied", http.StatusInternalServerError)
			return
		} else if errors.Is(err, os.ErrNotExist) {
			logSync(fmt.Sprintf("Sync texts: creating: '%s'", path), r)
			clientContent = clientFile.Content
		} else {
			// TODO file locks?
			fileWasModifiedOnServer := serverModifiedTime > clientFile.LastModified
			if fileWasModifiedOnServer {
				// Change on both client and server.
				serverContent, err := userFS.Read(fs.DirUserRoot, relativePath)
				if err != nil {
					slog.Error("Sync error: syncTexts: error reading modified on server file '%s': %v", path, err)
					http.Error(w, "Failed to read file; deletions not applied", http.StatusInternalServerError)
					return
				}
				logSync(fmt.Sprintf("🔀 Sync texts: Merging and writing: '%s'", path), r)
				clientContent = Merge(serverContent, clientFile.Content)
			} else {
				// Changed on client, unchanged on server.
				logSync(fmt.Sprintf("💻 Sync texts: Writing only: '%s'", path), r)
				clientContent = clientFile.Content
			}
		}

		// We don't accept config from client, because for now it is only modified on server.
		// Plus we need to mess with JSON merging :)
		if clientFile.Path == config.ServerCfg.ConfigFilename {
			continue
		}

		// Write the clientContent to the server at path.
		err = userFS.Write(fs.DirUserRoot, relativePath, clientContent)
		if errors.Is(err, fs.ErrQuotaExceeded) {
			http.Error(w, `{"error":"Storage quota exceeded"}`, http.StatusRequestEntityTooLarge)
			return
		}
		if err != nil {
			slog.Error("Sync error: syncTexts: error writing file '%s': %v", path, err)
			logSync(fmt.Sprintf("Sync texts: error writing file '%s': %v", path, err), r)
			http.Error(w, "Failed to write file; deletions not applied", http.StatusInternalServerError)
			return
		}

		if relativePath == fs.ChatFilename {
			OnChatUpdate(userID(r))
		}
	}

	// Delete files.
	for _, path := range request.Deleted {
		// Paths that are coming from client start with /, make them relative
		path = strings.TrimPrefix(path, "/")
		err = userFS.Del(fs.DirUserRoot, path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			slog.Error("Sync error: syncTexts: error deleting file", "path", path, "error", err)
			http.Error(w, "Failed to back up or delete file", http.StatusInternalServerError)
			return
		}
		logSync(fmt.Sprintf("❌ Sync texts: deleting file: '%s'", path), r)
		debugLogDelete(fmt.Sprintf("Deleting file: '%s'", path), r)
	}

	// Based on known client dirs timestamps, send newly updated or created files.
	serverTimestamps, err := userFS.Mtimes(fs.DirUserRoot, fs.MDExt, ".txt")
	if err != nil {
		slog.Error("Sync error: syncTexts: error getting server timestamps", "error", err)
		http.Error(w, fmt.Sprintf("Failed to get timestamps: %v", err), http.StatusInternalServerError)
		return
	}

	// Include config file timestamp, so it will be sent to the client if stale.
	configCtime, err := userFS.Mtime(fs.DirUserRoot, config.ServerCfg.ConfigFilename)
	// We can ignore the error since config.json is not used on client in any way, pure for read-only purposes.
	if err == nil {
		serverTimestamps[config.ServerCfg.ConfigFilename] = configCtime
	}

	// Prepare the list of files to send to the client
	// TODO optimize don't send files known to client.
	// For now we save client file to server, and the code below would include it again.
	files := make([]file, 0)
	dirTimestamps := make(map[string]int64)
	for path, serverFileTime := range serverTimestamps {
		// TOOD make it not as ugly?
		parts := strings.Split(path, string(os.PathSeparator))
		dir := parts[0]
		isInRoot := len(parts) == 1
		if isInRoot {
			dir = "."
		}

		requestDirTime, exists := request.Timestamps[dir]
		if !exists || serverFileTime > requestDirTime {
			// Client needs this file - read its content
			content, err := userFS.Read(fs.DirUserRoot, path)
			if err != nil {
				slog.Error("Sync error: syncTexts: error reading file", "path", path, "error", err)
				logSync(fmt.Sprintf("Error reading file %s: %v", path, err), r)
				continue
			}

			files = append(files, file{
				Status:       StatusOK,
				Path:         path,
				LastModified: serverFileTime,
				Content:      content,
			})
		}

		// Calculate the latest file timestamp for each directory
		existingTimestamp, exists := dirTimestamps[dir]
		if !exists {
			dirTimestamps[dir] = serverFileTime
			continue
		}
		if serverFileTime > existingTimestamp {
			dirTimestamps[dir] = serverFileTime
		}
	}

	// TODO Calculate deletions for client (files that exist on client but not on server)

	response := syncResponse{
		Status:     StatusOK,
		Files:      files,
		Timestamps: dirTimestamps,
		Renames:    renames,
		Deleted:    deletes,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Error encoding response", http.StatusInternalServerError)
	}
}

func SyncFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxTextSize)

	var clientFile file
	if err := json.NewDecoder(r.Body).Decode(&clientFile); err != nil {
		http.Error(w, "Invalid syncMediasRequest JSON", http.StatusBadRequest)
		return
	}

	userFS, err := fs.NewUserFS(userID(r))
	if err != nil {
		slog.Error("Sync error: syncText: error creating user FS", "error", err)
		http.Error(w, "Error creating user FS", http.StatusInternalServerError)
		return
	}

	// 1) Save client-modified file to the server
	// 2) In case of conflict (server has a newer modification), merge the clientFile and include them in the response

	// Paths that are coming from client start with /, make them relative.
	path := clientFile.Path
	relativePath := strings.TrimPrefix(path, "/")

	// TODO if no clientFile, severContent = ""
	serverContent, err := userFS.Read(fs.DirUserRoot, relativePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Error("Sync error: syncText: error reading clientFile", "path", path, "error", err)
		http.Error(w, "Error reading server clientFile", http.StatusBadRequest)
		return
	}

	serverLastModified, err := userFS.Mtime(fs.DirUserRoot, relativePath)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Error("Sync error: syncText: error getting ctime for clientFile '%s': %v", path, err)
			http.Error(w, "Error getting ctime for clientFile", http.StatusBadRequest)
			return
		}
	}

	// TODO when clientFile does not exist the content is empty, which is implicit
	// Return already up-to-date status
	if serverContent == clientFile.Content {
		response := map[string]interface{}{
			"status":       StatusNotModified,
			"lastModified": serverLastModified,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
		return
	}

	logSync(fmt.Sprintf("Client file '%s': last client modified: %d, last client synced: %d", path, clientFile.ClientLastModified, clientFile.ClientLastSynced), r)

	status := StatusOK
	var content string
	fileWasModifiedOnServer := false
	shouldUpdateOnServer := true
	if errors.Is(err, os.ErrNotExist) {
		logSync(fmt.Sprintf("Creating one clientFile: '%s'", path), r)
		content = clientFile.Content
	} else {
		wasNotModifiedOnClient := clientFile.ClientLastSynced != 0 && clientFile.ClientLastModified == clientFile.ClientLastSynced
		fileWasModifiedOnServer = serverLastModified > clientFile.LastModified
		if fileWasModifiedOnServer && wasNotModifiedOnClient {
			logSync(fmt.Sprintf("📡 Modified only on server, sending server copy to client: '%s'", path), r)
			content = serverContent
			shouldUpdateOnServer = false
		} else if fileWasModifiedOnServer { // Modified on both server and client
			logSync(fmt.Sprintf("File '%s' was modified on server at %d, but on client at %d", path, serverLastModified, clientFile.ClientLastModified), r)
			logSync(fmt.Sprintf("🔀 Merging and writing one clientFile: '%s'", path), r)
			content = Merge(serverContent, clientFile.Content)
			status = StatusMerged
		} else {
			// TODO for resilience add merge here, because we had case when server saved latest TS but no conent.
			// Also, if for some reason timestamps would change on server migration and such.
			// Server clientFile hasn't changed since client's last sync
			logSync(fmt.Sprintf("💻 Modified only on client, writing to server: '%s'", path), r)
			content = clientFile.Content
		}
	}

	if shouldUpdateOnServer {
		err = userFS.Write(fs.DirUserRoot, relativePath, content)
		if errors.Is(err, fs.ErrQuotaExceeded) {
			http.Error(w, `{"error":"Storage quota exceeded"}`, http.StatusRequestEntityTooLarge)
			return
		}
		if err != nil {
			slog.Error("Sync error: syncText: error writing clientFile '%s': %v", path, err)
			logSync(fmt.Sprintf("Error writing clientFile '%s': %v", path, err), r)
			http.Error(w, "Error writing clientFile", http.StatusInternalServerError)
			return
		}

		if relativePath == fs.ChatFilename {
			OnChatUpdate(userID(r))
		}
	}

	serverLastModified, err = userFS.Mtime(fs.DirUserRoot, relativePath)
	// TODO what if 0?
	logSync(fmt.Sprintf("Final server timestamp for '%s': %d", path, serverLastModified), r)

	if !fileWasModifiedOnServer {
		response := map[string]interface{}{
			"status":       StatusUpdatedOnServer,
			"lastModified": serverLastModified,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
		return
	}

	response := file{
		Status:       status,
		Content:      content,
		Path:         path,
		LastModified: serverLastModified,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Error encoding response", http.StatusInternalServerError)
		return
	}
}

func logSync(msg string, r *http.Request) {
	msg = fmt.Sprintf("%d: %s", userID(r), msg)

	file, err := os.OpenFile("/tmp/sync", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		fmt.Println("Error opening log file:", err)
		return
	}
	defer file.Close()

	if version := r.Header.Get("Version"); version != "" {
		msg = fmt.Sprintf("%s (version: %s)", msg, version)
	} else {
		msg = fmt.Sprintf("%s (version: unknown)", msg)
	}
	time := time.Now().Format("2006-01-02 15:04:05")
	msg = fmt.Sprintf("%s: %s\n", time, msg)
	if _, err := file.WriteString(msg); err != nil {
		slog.Error("Sync error: logSync: error writing to log file", "error", err)
		return
	}
}

func debugLogDelete(msg string, r *http.Request) {
	msg = fmt.Sprintf("%d: %s", userID(r), msg)
	file, err := os.OpenFile("/tmp/del", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		slog.Error("Sync error: logDelete: error opening log file", "error", err)
		return
	}
	defer file.Close()

	time := time.Now().Format("2006-01-02 15:04:05")
	if _, err := file.WriteString(time + ": " + msg + "\n"); err != nil {
		fmt.Println("Error writing to log file:", err)
		return
	}
}

func userID(r *http.Request) int64 {
	return r.Context().Value("userID").(int64)
}
