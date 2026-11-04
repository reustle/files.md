// Package notewatch delivers filesystem invalidations, never file contents or
// deletion instructions. Consumers must reconcile with a complete safe snapshot.
package notewatch

import (
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher shares one recursive set of OS watches among all connected clients.
// Directory watches survive atomic file replacement. Periodic invalidations
// cover dropped events, unavailable OS watches and network filesystems.
type Watcher struct {
	root, parent string
	rootInfo     os.FileInfo
	native       *fsnotify.Watcher
	watched      map[string]os.FileInfo
	stop, done   chan struct{}
	closeOnce    sync.Once
	mu           sync.Mutex
	closed       bool
	subs         map[chan struct{}]struct{}
}

func New(root string) (*Watcher, error) {
	return newWatcher(root, 15*time.Second, 80*time.Millisecond)
}

func newWatcher(root string, fallback, debounce time.Duration) (*Watcher, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("notes root must be a directory")
	}
	w := &Watcher{root: root, parent: filepath.Dir(root), rootInfo: info,
		watched: make(map[string]os.FileInfo), stop: make(chan struct{}), done: make(chan struct{}),
		subs: make(map[chan struct{}]struct{})}
	w.repair()
	go w.run(fallback, debounce)
	return w, nil
}

// Subscribe always queues an initial invalidation, including after reconnect.
// Slow consumers coalesce notifications instead of blocking the filesystem loop.
func (w *Watcher) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	w.mu.Lock()
	if w.closed {
		close(ch)
	} else {
		w.subs[ch] = struct{}{}
		ch <- struct{}{}
	}
	w.mu.Unlock()
	return ch, func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		if _, ok := w.subs[ch]; ok {
			delete(w.subs, ch)
			close(ch)
		}
	}
}

func (w *Watcher) Close() error {
	w.closeOnce.Do(func() { close(w.stop) })
	<-w.done
	return nil
}

func (w *Watcher) notify() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for ch := range w.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (w *Watcher) run(fallback, debounce time.Duration) {
	defer close(w.done)
	defer func() {
		if w.native != nil {
			_ = w.native.Close()
		}
		w.mu.Lock()
		defer w.mu.Unlock()
		w.closed = true
		for ch := range w.subs {
			close(ch)
			delete(w.subs, ch)
		}
	}()
	ticker := time.NewTicker(fallback)
	defer ticker.Stop()
	var timer *time.Timer
	var tick <-chan time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	repair := false
	queue := func(needsRepair bool) {
		repair = repair || needsRepair
		if tick == nil {
			timer = time.NewTimer(debounce)
			tick = timer.C
		}
	}
	for {
		var events <-chan fsnotify.Event
		var errors <-chan error
		if w.native != nil {
			events, errors = w.native.Events, w.native.Errors
		}
		select {
		case <-w.stop:
			return
		case event, ok := <-events:
			if !ok {
				_ = w.native.Close()
				w.native = nil
				w.watched = make(map[string]os.FileInfo)
				queue(true)
				continue
			}
			// The parent is watched only so the original root can be restored.
			if w.parent != w.root && filepath.Dir(event.Name) == w.parent && event.Name != w.root {
				continue
			}
			queue(event.Has(fsnotify.Create | fsnotify.Remove | fsnotify.Rename))
		case err, ok := <-errors:
			if !ok {
				_ = w.native.Close()
				w.native = nil
				w.watched = make(map[string]os.FileInfo)
			} else {
				slog.Warn("Notes watcher lost events; reconciling", "error", err)
			}
			queue(true)
		case <-tick:
			tick = nil
			if repair {
				w.repair()
				repair = false
			}
			w.notify()
		case <-ticker.C:
			w.repair()
			w.notify()
		}
	}
}

// repair is run only by the event loop (or before it starts). It repairs watches
// after directory moves, replacement, watch exhaustion and event queue overflow.
func (w *Watcher) repair() {
	if w.native == nil {
		var err error
		w.native, err = fsnotify.NewBufferedWatcher(256)
		if err != nil {
			slog.Warn("Notes watcher unavailable; using periodic reconciliation", "error", err)
			return
		}
	}
	desired := make(map[string]os.FileInfo)
	if info, err := os.Stat(w.parent); err == nil {
		desired[w.parent] = info
	}
	info, err := os.Lstat(w.root)
	if err == nil && info.IsDir() && os.SameFile(w.rootInfo, info) {
		err = filepath.WalkDir(w.root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.IsDir() {
				return nil
			} // Never follow symlinks.
			if path != w.root && strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			desired[path] = info
			return nil
		})
		// A partial walk must not discard still-useful watches. The independent
		// safe snapshot endpoint also rejects partial directory reads.
		if err != nil {
			return
		}
	}
	for path, old := range w.watched {
		if current, ok := desired[path]; !ok || !os.SameFile(old, current) {
			_ = w.native.Remove(path)
			delete(w.watched, path)
		}
	}
	for path, info := range desired {
		// fsnotify may remove a watch itself when a directory is renamed.
		// Re-adding an existing watch is harmless and repairs that case too.
		if err := w.native.Add(path); err != nil {
			slog.Warn("Cannot watch notes directory; periodic reconciliation remains active", "path", path, "error", err)
			continue
		}
		w.watched[path] = info
	}
}
