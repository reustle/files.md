# Local notes server

This entrypoint serves one existing notes directory as user 1, without the
Telegram bot. Run from a directory containing `web/`.

Configure these environment variables:

| Variable | Purpose |
| --- | --- |
| `NOTES_DIR` | Existing notes directory, used directly rather than a user subdirectory |
| `NOTES_BACKUP_DIR` | Backup directory outside `NOTES_DIR` |
| `APP_URL`, `API_URL` | Browser-facing URL, including scheme and port |
| `HTTP_ADDR` | HTTP listening address; defaults to `:8080` (all interfaces) |
| `TOKENS_DIR` | Private directory for persistent login tokens |
| `LOG_FILE` | Server log path |

Build with `go build -o /path/to/server ./cmd/local-server`. The server writes a
private `login-url` file in its working directory on startup. The link expires
after ten minutes; existing login cookies survive restarts. For remote access,
use HTTPS through a reverse proxy such as Tailscale Serve.

Configured workspaces start without sample notes, including when the notes
directory is empty. The browser's temporary mirror is separate from its demo
workspace. Missing browser entries never imply deletion. Deletions require an
explicit action and the last acknowledged server version; old clients are
rejected before sync mutations.

Visible browser tabs check the complete Markdown directory tree every two
seconds, and again on focus. Adds, edits, renames and deletions made on disk
appear without reloading. Content versions use SHA-256, so old or unchanged
modification times do not hide changes. An open, clean note updates in place;
a dirty editor keeps its text until it can be saved safely.

Edits and explicit deletions carry the content version the browser last read.
If the disk version has changed, the server preserves browser edits as Markdown
files under `Conflicts/` and cancels the batch's requested deletions. Browser
drafts and pending moves survive reloads while disconnected. Do not clear site
data while the sync indicator reports pending changes.

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
in a shared filesystem transaction.

Run the regression checks from the repository root:

```sh
go test ./...
go vet ./...
npm ci --prefix tests
npm run install:browsers --prefix tests
npm run test:safety --prefix tests
```

The safety tests build a separate server and use temporary directories and
loopback ports. They cover Chromium and Firefox with native and forced in-memory
storage, empty and populated workspaces, live external changes, stale-version
conflicts, offline reloads and moves, deep folders, and failed writes. Set `CHROMIUM_BIN` or `FIREFOX_BIN` to use an existing browser executable.
