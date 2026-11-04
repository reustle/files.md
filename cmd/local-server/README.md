# Local notes server

This entrypoint serves one existing notes directory as user 1, without the
Telegram bot. Run from a directory containing `web/`.

Configure these environment variables:

| Variable | Purpose |
| --- | --- |
| `NOTES_DIR` | Existing notes directory, used directly rather than a user subdirectory |
| `NOTES_BACKUP_DIR` | Backup directory outside `NOTES_DIR` |
| `APP_URL`, `API_URL` | Browser-facing URL, including scheme and port |
| `HTTP_ADDR` | HTTP listening address; set `0.0.0.0:8080` for remote development/testing |
| `TOKENS_DIR` | Private directory for persistent login tokens |
| `LOG_FILE` | Server log path |

Build with `go build -o /path/to/server ./cmd/local-server`. The server writes a
private `login-url` file in its working directory on startup. The link expires
after ten minutes; existing login cookies survive restarts. For remote access,
use HTTPS through a reverse proxy such as Tailscale Serve.
When `APP_URL` uses HTTPS, opening the local server through another hostname or
IP redirects to that configured URL, preserving the path and sign-in token.

Configured workspaces start without sample notes, including when the notes
directory is empty. The browser's temporary mirror is separate from its demo
workspace. Missing browser entries never imply deletion. Deletions require an
explicit action and the last acknowledged server version; old clients are
rejected before sync mutations.

The backend uses [fsnotify](https://github.com/fsnotify/fsnotify) directory
watches throughout the notes tree and pushes change notifications over an
authenticated event stream. Directory watches handle editors that atomically
replace files; new and moved directory trees are registered automatically.
Notifications only request a complete safe snapshot: a watcher event never
instructs a browser or the server to delete a file. Bursts are coalesced and slow
tabs cannot block saves. Reconnects always request a fresh snapshot.

Visible browser tabs also check the complete Markdown tree every two seconds,
and again on focus. The backend repairs watches and sends a fallback notification
every fifteen seconds, covering dropped events, watch limits, and filesystems
without native notification support. Adds, edits, renames and deletions made on
disk appear without reloading. Content versions use SHA-256, so old or unchanged
modification times do not hide changes. An open, clean note updates in place;
a dirty editor keeps its text until it can be saved safely.

Edits and explicit deletions carry the content version the browser last read.
If the disk version has changed, the server preserves browser edits as Markdown
files under `Conflicts/` and cancels the batch's requested deletions. Browser
drafts and pending titles are journaled on each edit. Separate tab journals keep
one tab from overwriting another tab's unsent work; conflicting recovered edits
become separate notes. Pending moves survive reloads while disconnected. A note
uses one editable buffer when opened in both panes. If browser storage is full,
the app warns you to keep the tab open or copy the text somewhere safe. Do not
clear site data while the sync indicator reports pending changes.

Folders can be nested at any depth. Expansion state is stored per full folder
path. Folder creation and cleanup are explicit operations; cleanup only removes
empty directories. Unsupported files, hidden entries and symbolic links are not
Markdown notes and are not removed by folder cleanup. Only `.md` files are
synchronized as notes; rename recovered `.txt` notes to `.md`.

A directory scan or read failure aborts sync rather than returning a partial
list that could look like deletions. If the configured root directory disappears
or is replaced while the server is running, requests fail until the intended
root is restored or the server is deliberately restarted.

Before overwriting or deleting an existing file, the local server preserves its
previous content under `NOTES_BACKUP_DIR/<relative-path>/<sha256>`. A backup
failure blocks that mutation. These content versions have no automatic expiry.
They cover changes made through this server; changes from other programs need
their own backup mechanism (for example, Syncthing versioning for changes
received from other devices). Writes are staged beside the note and renamed
atomically, so readers do not see truncated contents. Version checks and backups
reduce conflicts with other writers, but unrelated programs do not participate
in a shared filesystem transaction. Power-loss durability also depends on the
operating system, filesystem, and storage hardware; this is not a substitute for
an independent backup of the notes directory.

To recover a browser conflict, open the preserved Markdown note under
`Conflicts/` and copy the wanted content into a new note. To recover an earlier
server version or an explicitly deleted note, locate
`NOTES_BACKUP_DIR/<relative-note-path>/<sha256>`: each version is the complete
plain Markdown content, despite its extensionless name. Copy the chosen version
into `NOTES_DIR` under a new, unused `.md` filename, then reconcile it in the app.
Using a new filename keeps the current note available while you compare versions.
These backups cover server mutations; use an independent backup/versioning tool
for edits and deletions made by other programs.

Run the regression checks from the repository root:

```sh
go test -race ./...
go vet ./...
npm ci --prefix tests
npm run install:browsers --prefix tests
npm run test:safety --prefix tests
```

The safety tests build a separate server and use temporary directories and
ephemeral ports bound to `0.0.0.0`, accessed through loopback. They cover Chromium
and Firefox with native and forced in-memory storage, empty and populated
workspaces, live external changes, watcher reconnects, stale-version conflicts,
offline reloads, tab crashes, concurrent drafts, edits during requests, pending
titles, split panes, folder moves, immediate archiving, quota errors, and failed
writes. The Chromium native-storage case also runs with a real service worker.
Set `CHROMIUM_BIN` or `FIREFOX_BIN` to use an existing browser executable.
