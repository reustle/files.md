package fs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/spf13/afero"
)

var ErrNoteConflict = errors.New("note changed on disk")

type Note struct {
	Path         string `json:"path"`
	Content      string `json:"content"`
	Version      string `json:"version"`
	LastModified int64  `json:"lastModified"`
}

type NotesSnapshot struct {
	Files       map[string]Note `json:"files"`
	Directories []string        `json:"directories"`
}

func ContentVersion(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// Note paths are relative, canonical and never traverse hidden or linked dirs.
func (fs FS) notePath(name string) (string, error) {
	if !strings.EqualFold(filepath.Ext(name), ".md") {
		return "", ErrUnsafePath
	}
	return fs.entryPath(name)
}

func (fs FS) entryPath(name string) (string, error) {
	if name == "" || strings.Contains(name, "\\") || filepath.ToSlash(filepath.Clean(name)) != name {
		return "", ErrUnsafePath
	}
	full, err := fs.SafePath("/", name)
	if err != nil {
		return "", err
	}
	current := fs.rootPath
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return "", ErrUnsafePath
		}
		current = filepath.Join(current, part)
		var info os.FileInfo
		if backend, ok := fs.backend.(afero.Lstater); ok {
			info, _, err = backend.LstatIfPossible(current)
		} else {
			info, err = fs.backend.Stat(current)
		}
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", ErrUnsafePath
		}
	}
	return full, nil
}

func (fs FS) ReadNote(name string) (Note, error) {
	full, err := fs.notePath(name)
	if err != nil {
		return Note{}, err
	}
	// Check before opening: opening a FIFO named *.md can otherwise block the
	// whole sync server while it waits indefinitely for a writer.
	info, err := fs.backend.Stat(full)
	if err != nil {
		return Note{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > 5<<20 {
		return Note{}, fmt.Errorf("unsupported note size or type: %s", name)
	}
	file, err := fs.backend.Open(full)
	if err != nil {
		return Note{}, err
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		return Note{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > 5<<20 {
		return Note{}, fmt.Errorf("unsupported note size or type: %s", name)
	}
	content, err := io.ReadAll(io.LimitReader(file, (5<<20)+1))
	if err != nil {
		return Note{}, err
	}
	if len(content) > 5<<20 || !utf8.Valid(content) {
		return Note{}, fmt.Errorf("note must be UTF-8 text under 5 MB: %s", name)
	}
	return Note{Path: name, Content: string(content), Version: ContentVersion(string(content)), LastModified: Mtime(info)}, nil
}

// A partial scan must never be mistaken for a set of deleted files.
func (fs FS) SnapshotNotes() (NotesSnapshot, error) {
	result := NotesSnapshot{Files: map[string]Note{}, Directories: []string{}}
	err := afero.Walk(fs.backend, fs.rootPath, func(full string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if full == fs.rootPath {
			return nil
		}
		if strings.HasPrefix(info.Name(), ".") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(fs.rootPath, full)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if info.IsDir() {
			result.Directories = append(result.Directories, rel)
			return nil
		}
		if !strings.EqualFold(filepath.Ext(rel), ".md") {
			return nil
		}
		note, err := fs.ReadNote(rel)
		if err != nil {
			return err
		}
		result.Files[rel] = note
		return nil
	})
	return result, err
}

func (fs FS) CheckNoteVersion(name, expected string) error {
	note, err := fs.ReadNote(name)
	if errors.Is(err, os.ErrNotExist) {
		if expected == "" {
			return nil
		}
		return ErrNoteConflict
	}
	if err != nil {
		return err
	}
	if note.Version != expected {
		return ErrNoteConflict
	}
	return nil
}

// SyncNote makes a same-content retry durable before it is acknowledged. A
// previous rename may have succeeded even though its directory sync failed.
func (fs FS) SyncNote(name, expected string) error {
	if err := fs.CheckNoteVersion(name, expected); err != nil {
		return err
	}
	full, err := fs.notePath(name)
	if err != nil {
		return err
	}
	file, err := fs.backend.Open(full)
	if err != nil {
		return err
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	for dir := filepath.Dir(full); ; dir = filepath.Dir(dir) {
		if err := syncDirectory(fs.backend, dir); err != nil {
			return err
		}
		if dir == fs.rootPath || dir == filepath.Dir(dir) {
			return nil
		}
	}
}

// Stage complete contents beside the target, then rename. Readers never see a
// truncated file. Recheck after staging to catch edits from outside this server.
func (fs FS) WriteNote(name, content, expected string) error {
	full, err := fs.notePath(name)
	if err != nil {
		return err
	}
	if len(content) > 5<<20 || !utf8.ValidString(content) {
		return fmt.Errorf("note must be UTF-8 text under 5 MB")
	}
	if err := fs.CheckNoteVersion(name, expected); err != nil {
		return err
	}
	if err := fs.backend.MkdirAll(filepath.Dir(full), 0755); err != nil {
		return err
	}
	tmp, err := afero.TempFile(fs.backend, filepath.Dir(full), ".files-md-")
	if err != nil {
		return err
	}
	defer fs.backend.Remove(tmp.Name())
	if n, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	} else if n != len(content) {
		tmp.Close()
		return io.ErrShortWrite
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := fs.CheckNoteVersion(name, expected); err != nil {
		return err
	}
	return fs.backend.Rename(tmp.Name(), full)
}

func (fs FS) DeleteNote(name, expected string) error {
	full, err := fs.notePath(name)
	if err != nil {
		return err
	}
	if expected == "" {
		return ErrNoteConflict
	}
	if err := fs.CheckNoteVersion(name, expected); err != nil {
		return err
	}
	return fs.backend.Remove(full)
}

// Directory operations are explicit. Cleanup only removes an empty directory;
// newly arrived or unsupported files are never recursively deleted.
func (fs FS) CheckNoteDirectory(name string) error {
	full, err := fs.entryPath(name)
	if err != nil {
		return err
	}
	info, err := fs.backend.Stat(full)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("not a directory: %s", name)
	}
	return nil
}

func (fs FS) CreateNoteDirectory(name string) error {
	if err := fs.CheckNoteDirectory(name); err != nil {
		return err
	}
	full, err := fs.entryPath(name)
	if err != nil {
		return err
	}
	return fs.backend.MkdirAll(full, 0755)
}

func (fs FS) RemoveEmptyNoteDirectory(name string) error {
	if err := fs.CheckNoteDirectory(name); err != nil {
		return err
	}
	full, err := fs.entryPath(name)
	if err != nil {
		return err
	}
	if backend, ok := fs.backend.(interface{ RemoveEmptyDirectory(string) error }); ok {
		return backend.RemoveEmptyDirectory(full)
	}
	return fs.backend.Remove(full)
}
