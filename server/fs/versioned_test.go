package fs

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/require"
)

func TestVersionedOSFSPreservesOverwritesAndDeletions(t *testing.T) {
	root, backup := t.TempDir(), t.TempDir()
	name := filepath.Join(root, "note.md")
	require.NoError(t, os.WriteFile(name, []byte("original"), 0600))
	v := &VersionedOSFS{Fs: afero.NewOsFs(), Root: root, BackupDir: backup}
	require.NoError(t, afero.WriteFile(v, name, []byte("edited"), 0600))
	require.NoError(t, v.Remove(name))
	versions, err := os.ReadDir(filepath.Join(backup, "note.md"))
	require.NoError(t, err)
	var contents []string
	for _, version := range versions {
		data, err := os.ReadFile(filepath.Join(backup, "note.md", version.Name()))
		require.NoError(t, err)
		contents = append(contents, string(data))
	}
	require.ElementsMatch(t, []string{"original", "edited"}, contents)
}

func TestVersionedOSFSBackupFailureBlocksMutation(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "note.md")
	require.NoError(t, os.WriteFile(name, []byte("original"), 0600))
	v := &VersionedOSFS{Fs: afero.NewOsFs(), Root: root, BackupDir: name}
	require.Error(t, afero.WriteFile(v, name, []byte("edited"), 0600))
	require.Error(t, v.Remove(name))
	data, err := os.ReadFile(name)
	require.NoError(t, err)
	require.Equal(t, "original", string(data))
}

func TestVersionedOSFSRejectsSymlinks(t *testing.T) {
	root, other := t.TempDir(), t.TempDir()
	name := filepath.Join(other, "note.md")
	require.NoError(t, os.WriteFile(name, []byte("original"), 0600))
	require.NoError(t, os.Symlink(other, filepath.Join(root, "link")))
	v := &VersionedOSFS{Fs: afero.NewOsFs(), Root: root, BackupDir: t.TempDir()}
	require.Error(t, afero.WriteFile(v, filepath.Join(root, "link", "note.md"), []byte("edited"), 0600))
}
