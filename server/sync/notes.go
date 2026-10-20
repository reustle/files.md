package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/zakirullin/files.md/server/fs"
)

type noteChange struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Version string `json:"version"`
}

type notesRequest struct {
	Writes  []noteChange `json:"writes"`
	Deletes []noteChange `json:"deletes"`
	Mkdirs  []string     `json:"mkdirs"`
	Rmdirs  []string     `json:"rmdirs"`
}

type notesResponse struct {
	fs.NotesSnapshot
	Conflicts map[string]string `json:"conflicts"` // original path -> saved browser copy (empty for cancelled deletion)
}

// SyncNotes returns a complete, content-versioned view of the local directory.
// It never infers a client deletion from absence and never merges stale edits
// into the disk copy. Conflicting edits get separate, visible recovery notes.
func SyncNotes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var request notesRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxFilenamesSize)).Decode(&request); err != nil {
		http.Error(w, "Invalid notes request", http.StatusBadRequest)
		return
	}
	store, err := fs.NewUserFS(userID(r))
	if err != nil {
		http.Error(w, "Cannot open notes directory", 500)
		return
	}
	snapshot, err := store.SnapshotNotes()
	if err != nil {
		http.Error(w, "Cannot read complete notes directory: "+err.Error(), 500)
		return
	}
	for _, name := range append(append([]string{}, request.Mkdirs...), request.Rmdirs...) {
		if err := store.CheckNoteDirectory(name); err != nil {
			http.Error(w, "Cannot access directory: "+err.Error(), 400)
			return
		}
	}
	conflicts := map[string]string{}
	seen := map[string]bool{}
	for _, change := range append(append([]noteChange{}, request.Writes...), request.Deletes...) {
		if seen[change.Path] {
			http.Error(w, "Duplicate note operation", 400)
			return
		}
		seen[change.Path] = true
		if err := store.CheckNoteVersion(change.Path, change.Version); err != nil && !errors.Is(err, fs.ErrNoteConflict) {
			http.Error(w, "Cannot access note: "+err.Error(), 400)
			return
		}
	}
	for _, change := range request.Writes {
		if len(change.Content) > MaxTextSize {
			http.Error(w, "Note is too large", 413)
			return
		}
		current, exists := snapshot.Files[change.Path]
		if exists && current.Content == change.Content {
			continue
		} // retry of an acknowledged write
		if current.Version != change.Version {
			conflicts[change.Path] = ""
		}
	}
	for _, change := range request.Deletes {
		if change.Version == "" {
			http.Error(w, "Deletion needs a known version", 400)
			return
		}
		if current, exists := snapshot.Files[change.Path]; exists && current.Version != change.Version {
			conflicts[change.Path] = ""
		}
	}
	if len(conflicts) > 0 {
		// Preserve all conflicting browser writes before telling the client to
		// reload disk versions. No requested source deletions run in this case.
		for _, change := range request.Writes {
			if _, conflict := conflicts[change.Path]; !conflict {
				continue
			}
			name := strings.TrimSuffix(path.Base(change.Path), path.Ext(change.Path))
			copyPath := fmt.Sprintf("Conflicts/%s (browser %s).md", name, fs.ContentVersion(change.Path + "\x00" + change.Content)[:12])
			if old, ok := snapshot.Files[copyPath]; ok && old.Content != change.Content {
				copyPath = fmt.Sprintf("Conflicts/%s (browser %d).md", name, time.Now().UnixNano())
			}
			if old, ok := snapshot.Files[copyPath]; !ok || old.Content != change.Content {
				if err := store.WriteNote(copyPath, change.Content, ""); err != nil {
					http.Error(w, "Cannot preserve conflicting edit", 500)
					return
				}
			}
			conflicts[change.Path] = copyPath
		}
	} else {
		for _, name := range request.Mkdirs {
			if err := store.CreateNoteDirectory(name); err != nil {
				http.Error(w, "Cannot create directory", 500)
				return
			}
		}
		for _, change := range request.Writes {
			if current, ok := snapshot.Files[change.Path]; ok && current.Content == change.Content {
				continue
			}
			if err := store.WriteNote(change.Path, change.Content, change.Version); err != nil {
				http.Error(w, "Note changed or could not be saved; deletions not applied", http.StatusConflict)
				return
			}
		}
		for _, change := range request.Deletes {
			if _, err := store.ReadNote(change.Path); errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err := store.DeleteNote(change.Path, change.Version); err != nil {
				http.Error(w, "Note changed or could not be backed up; deletion refused", http.StatusConflict)
				return
			}
		}
	}
	if len(conflicts) == 0 {
		sort.Slice(request.Rmdirs, func(i, j int) bool { return len(request.Rmdirs[i]) > len(request.Rmdirs[j]) })
		for _, name := range request.Rmdirs {
			err := store.RemoveEmptyNoteDirectory(name)
			if err != nil && !errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ENOTEMPTY) && !errors.Is(err, syscall.EEXIST) {
				http.Error(w, "Cannot clean up empty directory", 500)
				return
			}
		}
	}
	snapshot, err = store.SnapshotNotes()
	if err != nil {
		http.Error(w, "Cannot read complete notes directory", 500)
		return
	}
	if len(conflicts) > 0 {
		w.WriteHeader(http.StatusConflict)
	}
	_ = json.NewEncoder(w).Encode(notesResponse{NotesSnapshot: snapshot, Conflicts: conflicts})
}
