package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/require"
	"github.com/zakirullin/files.md/server/config"
	"github.com/zakirullin/files.md/server/fs"
)

func TestSafeSyncRejectsUnconfirmedAndStaleDeletes(t *testing.T) {
	for _, baseline := range []int64{0, 2, 1} {
		t.Run(string(rune('0'+baseline)), func(t *testing.T) {
			oldCfg, oldFS := config.ServerCfg, fs.NewUserFS
			t.Cleanup(func() { config.ServerCfg = oldCfg; fs.NewUserFS = oldFS })
			config.ServerCfg.RequireSafeSync = true
			config.ServerCfg.ConfigFilename = "config.json"
			config.ServerCfg.WorkingDir = t.TempDir()
			userFS, err := fs.NewFS("/", afero.NewMemMapFs())
			require.NoError(t, err)
			require.NoError(t, userFS.Write("/", "original.md", "keep this"))
			fs.NewUserFS = func(int64) (*fs.FS, error) { return userFS, nil }
			body, err := json.Marshal(syncRequest{
				Deleted:         []string{"/original.md"},
				DeletedVersions: map[string]int64{"/original.md": baseline},
				Modified:        []file{{Path: "new.md", Content: "new"}},
			})
			require.NoError(t, err)
			req := httptest.NewRequest(http.MethodPost, "/syncFilenames", bytes.NewReader(body))
			req = req.WithContext(context.WithValue(req.Context(), "userID", int64(1)))
			w := httptest.NewRecorder()
			SyncFilenames(w, req)
			if baseline != 1 { // sync_test.go supplies a deterministic mtime of 1.
				require.Equal(t, http.StatusConflict, w.Code)
				content, err := userFS.Read("/", "original.md")
				require.NoError(t, err)
				require.Equal(t, "keep this", content)
				_, err = userFS.Read("/", "new.md")
				require.Error(t, err, "reject the whole request before any writes")
			} else {
				require.Equal(t, http.StatusOK, w.Code)
				_, err = userFS.Read("/", "original.md")
				require.Error(t, err)
				content, err := userFS.Read("/", "new.md")
				require.NoError(t, err)
				require.Equal(t, "new", content)
			}
		})
	}
}

func TestSafeSyncRejectsOldClientBeforeHandler(t *testing.T) {
	old := config.ServerCfg
	t.Cleanup(func() { config.ServerCfg = old })
	config.ServerCfg.RequireSafeSync = true
	called := false
	handler := tokenMiddleware(func(http.ResponseWriter, *http.Request) { called = true })
	w := httptest.NewRecorder()
	handler(w, httptest.NewRequest(http.MethodPost, "/syncFile", nil))
	require.Equal(t, http.StatusConflict, w.Code)
	require.False(t, called)
}

func TestSafeSyncFailedMoveWritePreservesSource(t *testing.T) {
	oldCfg, oldFS := config.ServerCfg, fs.NewUserFS
	t.Cleanup(func() { config.ServerCfg = oldCfg; fs.NewUserFS = oldFS })
	config.ServerCfg.RequireSafeSync = true
	config.ServerCfg.WorkingDir = t.TempDir()
	backend := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(backend, "/original.md", []byte("keep this"), 0600))
	userFS, err := fs.NewFS("/", failDestinationFS{Fs: backend})
	require.NoError(t, err)
	fs.NewUserFS = func(int64) (*fs.FS, error) { return userFS, nil }
	body, err := json.Marshal(syncRequest{
		Deleted:         []string{"/original.md"},
		DeletedVersions: map[string]int64{"/original.md": 1},
		Modified:        []file{{Path: "/destination.md", Content: "keep this"}},
	})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/syncFilenames", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), "userID", int64(1)))
	w := httptest.NewRecorder()
	SyncFilenames(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
	content, err := userFS.Read("/", "original.md")
	require.NoError(t, err)
	require.Equal(t, "keep this", content)
}

type failDestinationFS struct{ afero.Fs }

func (f failDestinationFS) OpenFile(name string, flag int, perm os.FileMode) (afero.File, error) {
	if name == "/destination.md" && flag&os.O_WRONLY != 0 {
		return nil, os.ErrPermission
	}
	return f.Fs.OpenFile(name, flag, perm)
}
