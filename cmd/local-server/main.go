package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/afero"
	"github.com/zakirullin/files.md/server/config"
	"github.com/zakirullin/files.md/server/fs"
	filesync "github.com/zakirullin/files.md/server/sync"
)

func main() {
	notes := os.Getenv("NOTES_DIR")
	backups := os.Getenv("NOTES_BACKUP_DIR")
	if notes == "" || backups == "" {
		panic("NOTES_DIR and NOTES_BACKUP_DIR are required")
	}
	var err error
	notes, err = filepath.EvalSymlinks(notes)
	if err != nil {
		panic(err)
	}
	notes, err = filepath.Abs(notes)
	if err != nil {
		panic(err)
	}
	if err := os.MkdirAll(backups, 0700); err != nil {
		panic(err)
	}
	backups, err = filepath.EvalSymlinks(backups)
	if err != nil {
		panic(err)
	}
	backups, err = filepath.Abs(backups)
	if err != nil {
		panic(err)
	}
	if backups == notes || strings.HasPrefix(backups, notes+string(os.PathSeparator)) {
		panic("Backups must be outside the notes folder")
	}
	backend := &fs.VersionedOSFS{Fs: afero.NewOsFs(), Root: notes, BackupDir: backups}
	if err := config.LoadBotConfig(); err != nil {
		panic(err)
	}
	fs.NewUserFS = func(userID int64) (*fs.FS, error) {
		if userID != 1 {
			return nil, fmt.Errorf("unknown local user")
		}
		return fs.NewFS(notes, backend, 0)
	}
	config.ServerCfg.RequireSafeSync = true
	// The existing sync log format namespaces paths by numeric user ID.
	logPath := func(name string) string {
		rel, err := filepath.Rel(notes, name)
		if err != nil {
			panic(err)
		}
		return filepath.Join(config.ServerCfg.StorageDir, "1", rel)
	}
	fs.LogRename = func(at int64, oldPath, newPath string) { filesync.LogRename(at, logPath(oldPath), logPath(newPath)) }
	fs.LogDelete = func(at int64, name string) { filesync.LogDelete(at, logPath(name)) }
	link := config.ServerCfg.AppURL + "/?token=" + filesync.GenOneTimeToken(1)
	if err := os.WriteFile("login-url", []byte(link+"\n"), 0600); err != nil {
		panic(err)
	}
	filesync.Serve(config.ServerCfg.APIHost(), config.ServerCfg.AppHost(), "", config.ServerCfg.ServerLogFile)
}
