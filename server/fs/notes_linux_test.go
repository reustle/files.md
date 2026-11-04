package fs

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/require"
)

func TestNotesSnapshotRejectsFIFOWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, syscall.Mkfifo(filepath.Join(root, "Pipe.md"), 0600))
	store, err := NewFS(root, afero.NewOsFs())
	require.NoError(t, err)
	result := make(chan error, 1)
	go func() {
		_, err := store.SnapshotNotes()
		result <- err
	}()
	select {
	case err := <-result:
		require.Error(t, err, "a special file must fail the complete snapshot")
	case <-time.After(time.Second):
		t.Fatal("snapshot blocked opening a FIFO")
	}
}
