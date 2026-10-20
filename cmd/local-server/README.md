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

Before overwriting or deleting an existing file, the local server preserves its
previous content under `NOTES_BACKUP_DIR/<relative-path>/<sha256>`. A backup
failure blocks that mutation. These content versions have no automatic expiry.
They cover changes made through this server; changes from other programs need
their own backup mechanism.

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
storage. Set `CHROMIUM_BIN` or `FIREFOX_BIN` to use an existing browser executable.
