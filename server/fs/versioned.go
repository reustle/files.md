package fs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/afero"
)

// VersionedOSFS preserves each distinct previous file content outside the notes
// folder before an overwrite, rename, or deletion. A failed backup blocks changes.
type VersionedOSFS struct {
	afero.Fs
	Root, BackupDir string
}

func (v *VersionedOSFS) LstatIfPossible(name string) (os.FileInfo, bool, error) {
	info, err := os.Lstat(name)
	return info, true, err
}

func (v *VersionedOSFS) preserve(name string) error {
	rel, err := filepath.Rel(v.Root, name)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("backup: path outside notes folder")
	}
	// Do not follow links out of the notes folder when backing up or writing.
	current := v.Root
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("backup: refusing to change symlink %s", current)
		}
	}
	info, err := os.Stat(name)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("backup: refusing recursive directory mutation")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(data)
	dir := filepath.Join(v.BackupDir, rel)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	dest := filepath.Join(dir, hex.EncodeToString(hash[:]))
	if _, err := os.Stat(dest); err == nil {
		return nil
	}
	tmp, err := os.CreateTemp(dir, ".backup-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chtimes(tmp.Name(), info.ModTime(), info.ModTime()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dest)
}

func (v *VersionedOSFS) OpenFile(name string, flag int, perm os.FileMode) (afero.File, error) {
	if flag&(os.O_WRONLY|os.O_RDWR|os.O_APPEND|os.O_TRUNC|os.O_CREATE) != 0 {
		if err := v.preserve(name); err != nil {
			return nil, err
		}
	}
	return v.Fs.OpenFile(name, flag, perm)
}

func (v *VersionedOSFS) Create(name string) (afero.File, error) {
	return v.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0666)
}

func (v *VersionedOSFS) Remove(name string) error {
	if strings.HasPrefix(filepath.Base(name), ".files-md-") {
		return v.Fs.Remove(name)
	}
	if err := v.preserve(name); err != nil {
		return err
	}
	return v.Fs.Remove(name)
}

func (v *VersionedOSFS) RemoveAll(name string) error {
	return fmt.Errorf("recursive deletion disabled for versioned notes")
}

func (v *VersionedOSFS) Rename(oldname, newname string) error {
	if !strings.HasPrefix(filepath.Base(oldname), ".files-md-") {
		if err := v.preserve(oldname); err != nil {
			return err
		}
	}
	if err := v.preserve(newname); err != nil {
		return err
	}
	return v.Fs.Rename(oldname, newname)
}

// Rmdir cannot remove a file or a nonempty directory, even if an external
// process changed the entry after the caller validated its path.
func (v *VersionedOSFS) RemoveEmptyDirectory(name string) error {
	return syscall.Rmdir(name)
}
