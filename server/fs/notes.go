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
	if name == "" || strings.Contains(name, "\\") || filepath.ToSlash(filepath.Clean(name)) != name || !strings.EqualFold(filepath.Ext(name), ".md") {
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
	file, err := fs.backend.Open(full)
	if err != nil {
		return Note{}, err
	}
	defer file.Close()
	info, err := file.Stat()
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

// Stage complete contents beside the target, then rename. Readers never see a
// truncated file. Recheck after staging to catch edits from outside this server.
func (fs FS) WriteNote(name, content, expected string) error {
	full, err := fs.notePath(name)
	if err != nil {
		return err
	}
	if len(content) > 5<<20 {
		return fmt.Errorf("note is too large")
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
	if _, err := tmp.WriteString(content); err != nil {
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
