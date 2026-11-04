# End-to-end tests

## Local notes safety suite

Use this suite for the standalone local notes server. It builds its own server
and uses disposable workspaces, backups, tokens, and ports. No `.env`, Telegram
account, or existing notes directory is needed.

```sh
go vet ./...
go test -race ./...
npm ci --prefix tests
cd tests
npx playwright install --with-deps chromium firefox
npm test
```

The browser matrix covers Chromium and Firefox, native and in-memory file
storage, and empty and populated workspaces. Assertions check actual note and
backup contents on disk, as well as browser state. Failed fixtures and logs are
retained under `/tmp/files-md-safety-*`; successful fixtures are cleaned up.
Set `BROWSER=chromium` or `BROWSER=firefox` to narrow the matrix.

The `Notes safety` GitHub Actions workflow runs race-enabled Go tests, vet,
and both browser variants on pushes and pull requests. See
[`cmd/local-server/README.md`](../cmd/local-server/README.md) for the storage
contract and recovery information.

`make e2e` runs this same maintained suite. It never stops an unrelated server
or uses an existing notes folder. The tests include read-only startup before a
verified disk connection, persistent authentication, independent project tabs,
eight background tabs, per-tab browser folder selections, and native draft
recovery in addition to the save/conflict/archive checks.

## Historical upstream specs

The `*.spec.js` files are retained for reference to the original application.
They assume its demo startup and legacy sync protocol, so they are not the
acceptance suite for this fork. If developing those historical features, run
`npm run test:legacy` (or `test:legacy:headed`, `test:legacy:ui`,
`test:legacy:debug`) with a separately configured disposable legacy server.
`make legacy-e2e test="name"` and `make legacy-e2eh test="name"` are convenience
wrappers; they do not start or stop backend servers. Those specs can replace
contents under the repository's `storage/<worker>/` directories; never point
that legacy setup at a real notes workspace.
