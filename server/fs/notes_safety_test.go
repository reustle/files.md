package fs

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/require"
)

type failingNoteFS struct {
	afero.Fs
	stage string
}

func (f failingNoteFS) OpenFile(name string, flag int, perm os.FileMode) (afero.File, error) {
	file, err := f.Fs.OpenFile(name, flag, perm)
	if err != nil || !strings.HasPrefix(filepath.Base(name), ".files-md-") {
		return file, err
	}
	return failingNoteFile{File: file, stage: f.stage}, nil
}

func (f failingNoteFS) Rename(oldname, newname string) error {
	if f.stage == "rename" {
		return os.ErrPermission
	}
	return f.Fs.Rename(oldname, newname)
}

type failingNoteFile struct {
	afero.File
	stage string
}

func (f failingNoteFile) WriteString(content string) (int, error) {
	if f.stage == "write" {
		return 0, io.ErrUnexpectedEOF
	}
	if f.stage == "short-write" {
		return f.File.WriteString(content[:len(content)/2])
	}
	return f.File.WriteString(content)
}

func (f failingNoteFile) Sync() error {
	if f.stage == "sync" {
		return os.ErrPermission
	}
	return f.File.Sync()
}

func (f failingNoteFile) Close() error {
	err := f.File.Close()
	if f.stage == "close" {
		return os.ErrPermission
	}
	return err
}

func TestAtomicNoteFailuresPreserveOriginalAndCleanStaging(t *testing.T) {
	for _, stage := range []string{"write", "short-write", "sync", "close", "rename"} {
		t.Run(stage, func(t *testing.T) {
			root := t.TempDir()
			name := filepath.Join(root, "Note.md")
			require.NoError(t, os.WriteFile(name, []byte("original"), 0600))
			store, err := NewFS(root, failingNoteFS{Fs: afero.NewOsFs(), stage: stage})
			require.NoError(t, err)
			require.Error(t, store.WriteNote("Note.md", "replacement", ContentVersion("original")))
			data, err := os.ReadFile(name)
			require.NoError(t, err)
			require.Equal(t, "original", string(data))
			entries, err := os.ReadDir(root)
			require.NoError(t, err)
			require.Len(t, entries, 1)
		})
	}
}

func TestNoteWritesRejectInvalidTextBeforeMutation(t *testing.T) {
	store, err := NewFS("/", afero.NewMemMapFs())
	require.NoError(t, err)
	for _, content := range []string{string([]byte{0xff}), strings.Repeat("x", (5<<20)+1)} {
		require.Error(t, store.WriteNote("Nested/Note.md", content, ""))
		snapshot, err := store.SnapshotNotes()
		require.NoError(t, err)
		require.Empty(t, snapshot.Files)
		require.Empty(t, snapshot.Directories)
	}
}

func TestNotesStateSequenceNeverDeletesWithoutMatchingExplicitVersion(t *testing.T) {
	store, err := NewFS("/", afero.NewMemMapFs())
	require.NoError(t, err)
	require.NoError(t, store.WriteNote("Note.md", "original", ""))
	baseline := ContentVersion("original")
	for i := 0; i < 50; i++ {
		content := strings.Repeat("changed ", i+1)
		require.NoError(t, store.WriteNote("Note.md", content, baseline))
		for _, stale := range []string{"", baseline, ContentVersion("unrelated")} {
			require.ErrorIs(t, store.DeleteNote("Note.md", stale), ErrNoteConflict)
			note, err := store.ReadNote("Note.md")
			require.NoError(t, err)
			require.Equal(t, content, note.Content)
		}
		baseline = ContentVersion(content)
	}
	require.NoError(t, store.DeleteNote("Note.md", baseline))
	_, err = store.ReadNote("Note.md")
	require.True(t, errors.Is(err, os.ErrNotExist))
}

func TestVersionedBackupsMustContainVerifiedOriginalBytes(t *testing.T) {
	for _, damaged := range []string{"truncated", "directory", "symlink"} {
		t.Run(damaged, func(t *testing.T) {
			root, backup := t.TempDir(), t.TempDir()
			name := filepath.Join(root, "Note.md")
			require.NoError(t, os.WriteFile(name, []byte("original"), 0600))
			dir := filepath.Join(backup, "Note.md")
			require.NoError(t, os.Mkdir(dir, 0700))
			dest := filepath.Join(dir, ContentVersion("original"))
			switch damaged {
			case "truncated":
				require.NoError(t, os.WriteFile(dest, []byte("damaged"), 0600))
			case "directory":
				require.NoError(t, os.Mkdir(dest, 0700))
			case "symlink":
				require.NoError(t, os.Symlink(name, dest))
			}
			store, err := NewFS(root, &VersionedOSFS{Fs: afero.NewOsFs(), Root: root, BackupDir: backup})
			require.NoError(t, err)
			require.Error(t, store.WriteNote("Note.md", "replacement", ContentVersion("original")))
			require.Error(t, store.DeleteNote("Note.md", ContentVersion("original")))
			data, err := os.ReadFile(name)
			require.NoError(t, err)
			require.Equal(t, "original", string(data))
		})
	}
}

func TestVersionedBackupRejectsLinkedAncestorEvenWhenLeafExists(t *testing.T) {
	root, backup, elsewhere := t.TempDir(), t.TempDir(), t.TempDir()
	name := filepath.Join(root, "Nested", "Note.md")
	require.NoError(t, os.MkdirAll(filepath.Dir(name), 0700))
	require.NoError(t, os.WriteFile(name, []byte("original"), 0600))
	require.NoError(t, os.Mkdir(filepath.Join(elsewhere, "Note.md"), 0700))
	require.NoError(t, os.Symlink(elsewhere, filepath.Join(backup, "Nested")))
	store, err := NewFS(root, &VersionedOSFS{Fs: afero.NewOsFs(), Root: root, BackupDir: backup})
	require.NoError(t, err)
	require.Error(t, store.DeleteNote("Nested/Note.md", ContentVersion("original")))
	note, err := store.ReadNote("Nested/Note.md")
	require.NoError(t, err)
	require.Equal(t, "original", note.Content)
}
