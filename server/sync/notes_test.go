package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/require"
	"github.com/zakirullin/files.md/server/fs"
)

func notesFixture(t *testing.T) (string, *fs.FS, func(notesRequest) (int, notesResponse)) {
	t.Helper()
	root, backups := t.TempDir(), t.TempDir()
	store, err := fs.NewFS(root, &fs.VersionedOSFS{Fs: afero.NewOsFs(), Root: root, BackupDir: backups})
	require.NoError(t, err)
	old := fs.NewUserFS
	fs.NewUserFS = func(int64) (*fs.FS, error) { return store, nil }
	t.Cleanup(func() { fs.NewUserFS = old })
	call := func(request notesRequest) (int, notesResponse) {
		data, err := json.Marshal(request)
		require.NoError(t, err)
		r := httptest.NewRequest(http.MethodPost, "/notes/sync", bytes.NewReader(data))
		r = r.WithContext(context.WithValue(r.Context(), "userID", int64(1)))
		w := httptest.NewRecorder()
		SyncNotes(w, r)
		var result notesResponse
		_ = json.Unmarshal(w.Body.Bytes(), &result)
		return w.Code, result
	}
	return root, store, call
}

func TestNotesDetectOldTimestampsAndDeepFiles(t *testing.T) {
	root, _, call := notesFixture(t)
	name := "a/b/c/d/e/f/g/h/i/j/k/l/Note.md"
	require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(root, name), []byte("first"), 0600))
	old := time.Unix(1, 0)
	require.NoError(t, os.Chtimes(filepath.Join(root, name), old, old))
	code, first := call(notesRequest{})
	require.Equal(t, 200, code)
	require.Equal(t, "first", first.Files[name].Content)
	require.Len(t, first.Directories, 12)
	require.NoError(t, os.WriteFile(filepath.Join(root, name), []byte("second"), 0600))
	require.NoError(t, os.Chtimes(filepath.Join(root, name), old, old))
	code, second := call(notesRequest{})
	require.Equal(t, 200, code)
	require.NotEqual(t, first.Files[name].Version, second.Files[name].Version)
	require.Equal(t, "second", second.Files[name].Content)
}

func TestNotesConcurrentEditKeepsDiskAndBrowserCopies(t *testing.T) {
	root, store, call := notesFixture(t)
	require.NoError(t, store.WriteNote("Note.md", "original", ""))
	_, initial := call(notesRequest{})
	require.NoError(t, os.WriteFile(filepath.Join(root, "Note.md"), []byte("edited on disk"), 0600))
	request := notesRequest{Writes: []noteChange{{Path: "Note.md", Content: "edited in browser", Version: initial.Files["Note.md"].Version}}}
	code, result := call(request)
	require.Equal(t, 409, code)
	require.Equal(t, "edited on disk", result.Files["Note.md"].Content)
	copyPath := result.Conflicts["Note.md"]
	require.NotEmpty(t, copyPath)
	require.Equal(t, "edited in browser", result.Files[copyPath].Content)
	_, retry := call(request)
	require.Len(t, retry.Files, 2, "retry must not create endless conflict copies")
}

func TestNotesDeletionNeedsMatchingContentAndCancelsWholeBatch(t *testing.T) {
	root, store, call := notesFixture(t)
	require.NoError(t, store.WriteNote("Note.md", "original", ""))
	_, initial := call(notesRequest{})
	require.NoError(t, os.WriteFile(filepath.Join(root, "Note.md"), []byte("disk edit"), 0600))
	code, result := call(notesRequest{
		Writes:  []noteChange{{Path: "New.md", Content: "new"}},
		Deletes: []noteChange{{Path: "Note.md", Version: initial.Files["Note.md"].Version}},
	})
	require.Equal(t, 409, code)
	require.Equal(t, "disk edit", result.Files["Note.md"].Content)
	require.NotContains(t, result.Files, "New.md")
	code, result = call(notesRequest{Deletes: []noteChange{{Path: "Note.md", Version: result.Files["Note.md"].Version}}})
	require.Equal(t, 200, code)
	require.Empty(t, result.Files)
}

func TestNotesDeletedDiskFileIsNotResurrectedByStaleBrowser(t *testing.T) {
	root, store, call := notesFixture(t)
	require.NoError(t, store.WriteNote("Note.md", "original", ""))
	_, initial := call(notesRequest{})
	require.NoError(t, os.Remove(filepath.Join(root, "Note.md")))
	code, result := call(notesRequest{Writes: []noteChange{{Path: "Note.md", Content: "offline edit", Version: initial.Files["Note.md"].Version}}})
	require.Equal(t, 409, code)
	require.NotContains(t, result.Files, "Note.md")
	require.Equal(t, "offline edit", result.Files[result.Conflicts["Note.md"]].Content)
}

func TestNotesUnreadableSnapshotNeverDeletesAnything(t *testing.T) {
	root, store, call := notesFixture(t)
	require.NoError(t, store.WriteNote("Note.md", "original", ""))
	_, initial := call(notesRequest{})
	require.NoError(t, os.WriteFile(filepath.Join(root, "Bad.md"), []byte{0xff}, 0600))
	code, _ := call(notesRequest{Deletes: []noteChange{{Path: "Note.md", Version: initial.Files["Note.md"].Version}}})
	require.Equal(t, 500, code)
	data, err := os.ReadFile(filepath.Join(root, "Note.md"))
	require.NoError(t, err)
	require.Equal(t, "original", string(data))
}

func TestNotesIgnoreLinksAndRejectTraversal(t *testing.T) {
	root, _, call := notesFixture(t)
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "Private.md"), []byte("private"), 0600))
	require.NoError(t, os.Symlink(outside, filepath.Join(root, "linked")))
	code, result := call(notesRequest{})
	require.Equal(t, 200, code)
	require.Empty(t, result.Files)
	for _, name := range []string{"../Private.md", "linked/Private.md", ".hidden/Private.md", "/absolute.md", "not-markdown.txt"} {
		code, _ = call(notesRequest{Writes: []noteChange{{Path: name, Content: "changed"}}})
		require.Equal(t, 400, code, name)
	}
	data, err := os.ReadFile(filepath.Join(outside, "Private.md"))
	require.NoError(t, err)
	require.Equal(t, "private", string(data))
}

func TestNotesExplicitDirectoryOperationsKeepUnlistedFiles(t *testing.T) {
	root, store, call := notesFixture(t)
	code, result := call(notesRequest{Mkdirs: []string{"Empty/Nested", "Moved"}})
	require.Equal(t, 200, code)
	require.Contains(t, result.Directories, "Empty/Nested")
	require.NoError(t, store.WriteNote("Empty/Nested/Note.md", "content", ""))
	require.NoError(t, os.WriteFile(filepath.Join(root, "Empty", "unlisted.txt"), []byte("keep me"), 0600))
	code, result = call(notesRequest{
		Writes:  []noteChange{{Path: "Moved/Note.md", Content: "content"}},
		Deletes: []noteChange{{Path: "Empty/Nested/Note.md", Version: fs.ContentVersion("content")}},
		Rmdirs:  []string{"Empty", "Empty/Nested"},
	})
	require.Equal(t, 200, code)
	require.Contains(t, result.Directories, "Empty", "nonempty source directory must survive")
	require.NotContains(t, result.Directories, "Empty/Nested")
	data, err := os.ReadFile(filepath.Join(root, "Empty", "unlisted.txt"))
	require.NoError(t, err)
	require.Equal(t, "keep me", string(data))
	require.Equal(t, "content", result.Files["Moved/Note.md"].Content)
	for _, name := range []string{"", ".", "..", "../outside", ".hidden", "/absolute", "Moved/Note.md"} {
		code, _ = call(notesRequest{Rmdirs: []string{name}})
		require.Equal(t, 400, code, name)
	}
	code, result = call(notesRequest{Rmdirs: []string{"Moved"}})
	require.Equal(t, 200, code)
	require.Contains(t, result.Files, "Moved/Note.md", "folder cleanup is never recursive")
}

func TestNotesEmptyRequestsAndRetriedWritesNeverInferDeletions(t *testing.T) {
	_, store, call := notesFixture(t)
	require.NoError(t, store.WriteNote("Unlisted.md", "keep forever", ""))
	request := notesRequest{Writes: []noteChange{{Path: "Draft.md", Content: "saved once"}}}
	for i := 0; i < 20; i++ {
		// The client has no inventory in a fresh/cleared browser, and a lost
		// acknowledgement causes the old create request to be sent again.
		code, result := call(notesRequest{})
		require.Equal(t, 200, code)
		require.Equal(t, "keep forever", result.Files["Unlisted.md"].Content)
		code, result = call(request)
		require.Equal(t, 200, code)
		require.Empty(t, result.Conflicts)
		require.Len(t, result.Files, 2)
		require.Equal(t, "keep forever", result.Files["Unlisted.md"].Content)
		require.Equal(t, "saved once", result.Files["Draft.md"].Content)
	}
}

type afterNoteRenameFS struct {
	afero.Fs
	after func(string) error
}

func (f afterNoteRenameFS) Rename(oldname, newname string) error {
	if err := f.Fs.Rename(oldname, newname); err != nil {
		return err
	}
	return f.after(newname)
}

func TestNotesInterruptedMoveCanBeRetriedWithoutLosingSource(t *testing.T) {
	root, store, call := notesFixture(t)
	require.NoError(t, store.WriteNote("Source.md", "valuable", ""))
	failed := false
	backend := afterNoteRenameFS{Fs: afero.NewOsFs(), after: func(name string) error {
		if filepath.Base(name) == "Destination.md" && !failed {
			failed = true
			return os.ErrPermission // Rename happened, but durability acknowledgement failed.
		}
		return nil
	}}
	store, err := fs.NewFS(root, &fs.VersionedOSFS{Fs: backend, Root: root, BackupDir: t.TempDir()})
	require.NoError(t, err)
	fs.NewUserFS = func(int64) (*fs.FS, error) { return store, nil }
	request := notesRequest{
		Writes:  []noteChange{{Path: "Destination.md", Content: "valuable"}},
		Deletes: []noteChange{{Path: "Source.md", Version: fs.ContentVersion("valuable")}},
	}
	code, _ := call(request)
	require.Equal(t, 409, code)
	for _, name := range []string{"Source.md", "Destination.md"} {
		note, err := store.ReadNote(name)
		require.NoError(t, err)
		require.Equal(t, "valuable", note.Content)
	}
	for i := 0; i < 3; i++ {
		code, result := call(request)
		require.Equal(t, 200, code)
		require.Len(t, result.Files, 1)
		require.Equal(t, "valuable", result.Files["Destination.md"].Content)
	}
}

func TestNotesMoveRechecksAllContentsBeforeAnyDeletion(t *testing.T) {
	for _, changed := range []string{"Destination.md", "Second.md"} {
		t.Run(changed, func(t *testing.T) {
			root, store, call := notesFixture(t)
			for _, name := range []string{"Source.md", "Second.md"} {
				require.NoError(t, store.WriteNote(name, "valuable", ""))
			}
			backend := afterNoteRenameFS{Fs: afero.NewOsFs(), after: func(string) error {
				return os.WriteFile(filepath.Join(root, changed), []byte("external edit"), 0600)
			}}
			store, err := fs.NewFS(root, &fs.VersionedOSFS{Fs: backend, Root: root, BackupDir: t.TempDir()})
			require.NoError(t, err)
			fs.NewUserFS = func(int64) (*fs.FS, error) { return store, nil }
			code, _ := call(notesRequest{
				Writes: []noteChange{{Path: "Destination.md", Content: "valuable"}},
				Deletes: []noteChange{
					{Path: "Source.md", Version: fs.ContentVersion("valuable")},
					{Path: "Second.md", Version: fs.ContentVersion("valuable")},
				},
			})
			require.Equal(t, 409, code)
			for _, name := range []string{"Source.md", "Second.md"} {
				_, err := store.ReadNote(name)
				require.NoError(t, err, "no source deletion may run after a destination or source changed")
			}
		})
	}
}

type failConfirmSyncFS struct {
	afero.Fs
	name string
}

func (f failConfirmSyncFS) Open(name string) (afero.File, error) {
	file, err := f.Fs.Open(name)
	if err != nil || name != f.name {
		return file, err
	}
	return failConfirmSyncFile{file}, nil
}

type failConfirmSyncFile struct{ afero.File }

func (f failConfirmSyncFile) Sync() error { return os.ErrPermission }

func TestNotesRetryRequiresDurableDestinationBeforeDeletingSource(t *testing.T) {
	for _, failAt := range []string{"Destination.md", "."} {
		t.Run(failAt, func(t *testing.T) {
			root, store, call := notesFixture(t)
			for _, name := range []string{"Source.md", "Destination.md"} {
				require.NoError(t, store.WriteNote(name, "valuable", ""))
			}
			backend := failConfirmSyncFS{Fs: afero.NewOsFs(), name: filepath.Join(root, failAt)}
			store, err := fs.NewFS(root, &fs.VersionedOSFS{Fs: backend, Root: root, BackupDir: t.TempDir()})
			require.NoError(t, err)
			fs.NewUserFS = func(int64) (*fs.FS, error) { return store, nil }
			code, _ := call(notesRequest{
				Writes:  []noteChange{{Path: "Destination.md", Content: "valuable"}},
				Deletes: []noteChange{{Path: "Source.md", Version: fs.ContentVersion("valuable")}},
			})
			require.Equal(t, 409, code)
			note, err := store.ReadNote("Source.md")
			require.NoError(t, err)
			require.Equal(t, "valuable", note.Content)
		})
	}
}
