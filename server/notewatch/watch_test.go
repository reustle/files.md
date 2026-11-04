package notewatch

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/stretchr/testify/require"
)

func testWatcher(t *testing.T, root string) (*Watcher, <-chan struct{}) {
	t.Helper()
	w, err := newWatcher(root, time.Hour, 10*time.Millisecond)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, w.Close()) })
	ch, cancel := w.Subscribe()
	t.Cleanup(cancel)
	awaitChange(t, ch)
	return w, ch
}

func awaitChange(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case _, ok := <-ch:
		require.True(t, ok, "watcher closed unexpectedly")
	case <-time.After(3 * time.Second):
		t.Fatal("filesystem change was not delivered")
	}
}

func settle(ch <-chan struct{}) {
	timer := time.NewTimer(60 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ch:
		case <-timer.C:
			return
		}
	}
}

func TestRecursiveChangesAndAtomicReplacement(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "one", "two", "three")
	require.NoError(t, os.MkdirAll(dir, 0700))
	_, ch := testWatcher(t, root)
	name := filepath.Join(dir, "Note.md")
	for _, content := range []string{"first", "second", "third"} {
		settle(ch)
		stage := filepath.Join(dir, ".save-tmp")
		require.NoError(t, os.WriteFile(stage, []byte(content), 0600))
		require.NoError(t, os.Rename(stage, name))
		awaitChange(t, ch)
	}
	settle(ch)
	require.NoError(t, os.Remove(name))
	awaitChange(t, ch)
}

func TestNewMovedAndRenamedDirectoryTreesStayWatched(t *testing.T) {
	root := t.TempDir()
	_, ch := testWatcher(t, root)
	dir := filepath.Join(root, "new", "deep", "tree")
	require.NoError(t, os.MkdirAll(dir, 0700))
	awaitChange(t, ch)
	settle(ch)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "Note.md"), []byte("new"), 0600))
	awaitChange(t, ch)
	settle(ch)
	require.NoError(t, os.Rename(filepath.Join(root, "new"), filepath.Join(root, "renamed")))
	awaitChange(t, ch)
	settle(ch)
	require.NoError(t, os.WriteFile(filepath.Join(root, "renamed", "deep", "tree", "Note.md"), []byte("edit"), 0600))
	awaitChange(t, ch)
	settle(ch)
	outside := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(outside, "nested"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(outside, "nested", "Moved.md"), []byte("moved"), 0600))
	require.NoError(t, os.Rename(outside, filepath.Join(root, "imported")))
	awaitChange(t, ch)
	settle(ch)
	require.NoError(t, os.WriteFile(filepath.Join(root, "imported", "nested", "Moved.md"), []byte("later"), 0600))
	awaitChange(t, ch)
}

func TestRootReplacementIsNotAdoptedAndRestoredRootRecovers(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "notes")
	require.NoError(t, os.Mkdir(root, 0700))
	_, ch := testWatcher(t, root)
	require.NoError(t, os.Rename(root, filepath.Join(base, "original")))
	awaitChange(t, ch)
	require.NoError(t, os.Mkdir(root, 0700))
	awaitChange(t, ch)
	settle(ch)
	require.NoError(t, os.WriteFile(filepath.Join(root, "Wrong.md"), []byte("not our root"), 0600))
	select {
	case <-ch:
		t.Fatal("replacement root must not be watched")
	case <-time.After(80 * time.Millisecond):
	}
	require.NoError(t, os.Rename(root, filepath.Join(base, "replacement")))
	require.NoError(t, os.Rename(filepath.Join(base, "original"), root))
	awaitChange(t, ch)
	settle(ch)
	require.NoError(t, os.WriteFile(filepath.Join(root, "Back.md"), []byte("restored"), 0600))
	awaitChange(t, ch)
}

func TestHiddenAndSymlinkDirectoriesAreNotTraversed(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(root, ".hidden"), 0700))
	require.NoError(t, os.Symlink(outside, filepath.Join(root, "link")))
	_, ch := testWatcher(t, root)
	require.NoError(t, os.WriteFile(filepath.Join(root, ".hidden", "Secret.md"), []byte("hidden"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(outside, "Private.md"), []byte("private"), 0600))
	select {
	case <-ch:
		t.Fatal("hidden or linked directory was watched")
	case <-time.After(80 * time.Millisecond):
	}
}

func TestOverflowForcesReconciliationAndContinuesWatching(t *testing.T) {
	root := t.TempDir()
	w, ch := testWatcher(t, root)
	w.native.Errors <- fsnotify.ErrEventOverflow
	awaitChange(t, ch)
	settle(ch)
	require.NoError(t, os.WriteFile(filepath.Join(root, "After.md"), []byte("safe"), 0600))
	awaitChange(t, ch)
}

func TestPeriodicFallbackAndSlowSubscriber(t *testing.T) {
	w, err := newWatcher(t.TempDir(), 20*time.Millisecond, time.Millisecond)
	require.NoError(t, err)
	t.Cleanup(func() { _ = w.Close() })
	slow, cancelSlow := w.Subscribe()
	defer cancelSlow()
	fast, cancelFast := w.Subscribe()
	defer cancelFast()
	awaitChange(t, fast)
	// No OS activity: fallback still reconciles, even if another tab is stuck.
	for range 3 {
		awaitChange(t, fast)
	}
	require.Len(t, slow, 1)
	cancelSlow()
	_, open := <-slow // The initial buffered event can still be drained.
	if open {
		_, open = <-slow
	}
	require.False(t, open)
	require.NoError(t, w.Close())
	require.NoError(t, w.Close())
	closed, cancel := w.Subscribe()
	defer cancel()
	_, open = <-closed
	require.False(t, open)
}
