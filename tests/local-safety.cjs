// npm run test:safety (builds the Go server; uses only disposable notes/ports).
// Optional: BROWSER=chromium|firefox, CHROMIUM_BIN, FIREFOX_BIN, or a server
// executable as the first argument. Failed fixtures are retained for inspection.
const {chromium, firefox} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const assert = require('node:assert/strict');
const verifyArchiveSafety = require('./archive-safety.cjs');

const repo = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureTimeoutMs = Number(process.env.SAFETY_FIXTURE_TIMEOUT_MS || 120000);
assert.ok(Number.isFinite(fixtureTimeoutMs) && fixtureTimeoutMs > 0, 'SAFETY_FIXTURE_TIMEOUT_MS must be positive');

async function withTimeout(work, milliseconds, message) {
    let timer;
    try {
        return await Promise.race([
            work,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
        ]);
    } finally { clearTimeout(timer); }
}
const originals = {
    'Original.md': 'Original content',
    'Plain.md': 'Plain text content',
    'Help.md': 'My own help note',
    'nested/Note.md': 'Nested content',
    'unrelated.csv': 'Untouched,unsupported\n',
};

async function snapshot(dir, prefix = '') {
    const result = {};
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) {
            Object.assign(result, await snapshot(path.join(dir, entry.name), relative + '/'));
        } else {
            result[relative] = await fs.readFile(path.join(dir, entry.name), 'utf8');
        }
    }
    return result;
}

async function availablePort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(0, '0.0.0.0', resolve);
    });
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

async function waitForServer(child, url, root) {
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Test server exited: ${await fs.readFile(path.join(root, 'server.log'), 'utf8')}`);
        }
        try {
            if ((await fetch(url, {signal: AbortSignal.timeout(500)})).ok) {
                await fs.access(path.join(root, 'login-url'));
                return;
            }
        } catch {}
        await delay(50);
    }
    throw new Error('Disposable test server did not become ready');
}

async function waitForSync(page) {
    await page.waitForFunction(() =>
        server.initialized && !isSyncingFiles && !isSyncingMedia && !isLoadingLocalFiles);
}

async function assertNoSamples(page) {
    const samples = await page.evaluate(async () => {
        const found = [];
        async function visit(entries, prefix = '/') {
            for (const [name, data] of Object.entries(entries)) {
                if (data.isFile) {
                    if (await exists(prefix + name)) found.push(prefix + name);
                } else {
                    await visit(data, prefix + name);
                }
            }
        }
        await visit(WELCOME_FILES);
        return found;
    });
    assert.deepEqual(samples, [], 'A configured workspace must not seed sample files');
}

async function verifyFolderPicker(page) {
    const result = await page.evaluate(async () => {
        clearInterval(window.saver);
        localStorage.removeItem(LAST_SERVER_OK_KEY);
        const root = await navigator.storage.getDirectory();
        const selected = await root.getDirectoryHandle('selected-test-folder', {create: true});
        const help = await selected.getFileHandle('Help.md', {create: true});
        const writer = await help.createWritable();
        await writer.write('Existing help must survive opening a folder');
        await writer.close();
        window.showDirectoryPicker = async () => selected;
        await openDir();
        // A browser can support selected folders without the nonstandard remove().
        const descriptor = Object.getOwnPropertyDescriptor(FileSystemFileHandle.prototype, 'remove');
        Object.defineProperty(FileSystemFileHandle.prototype, 'remove', {value: undefined, configurable: true});
        try {
            const sameFolder = await (await getRootDirHandle()).isSameEntry(selected);
            const helpContent = await read('/Help.md');
            await write('/delete-me.md', 'Disposable');
            await remove('/delete-me.md');
            return {sameFolder, helpContent, removed: !await exists('/delete-me.md')};
        } finally {
            if (descriptor) Object.defineProperty(FileSystemFileHandle.prototype, 'remove', descriptor);
            else delete FileSystemFileHandle.prototype.remove;
        }
    });
    assert.deepEqual(result, {
        sameFolder: true,
        helpContent: 'Existing help must survive opening a folder',
        removed: true,
    });
    await assertNoSamples(page);
}

async function verifyLiveChanges(page, notes) {
    const watched = path.join(notes, 'Watching');
    await fs.mkdir(watched);
    const filename = path.join(watched, 'Live.md');
    await fs.writeFile(filename, 'Stable line\nOld ending');
    await fs.utimes(filename, new Date(1000), new Date(1000));
    // No focus/blur or manual sync: the poll must discover an old-dated file.
    await page.waitForFunction(() => !isSyncingFiles && getMemFile('/Watching/Live.md'));
    assert.equal(await page.evaluate(() => read('/Watching/Live.md')), 'Stable line\nOld ending');
    await page.evaluate(async () => {
        await openFile('/Watching/Live.md');
        currentEditor.setCursor({line: 1, ch: 3});
    });
    await fs.writeFile(filename, 'Stable line\nUpdated on disk');
    await fs.utimes(filename, new Date(1000), new Date(1000));
    await page.waitForFunction(() => currentEditor.getValue() === '# Live\nStable line\nUpdated on disk');
    assert.deepEqual(await page.evaluate(() => ({line: currentEditor.getCursor().line, ch: currentEditor.getCursor().ch})), {line: 1, ch: 3});

    // An external rename is reflected without resurrecting the old name.
    const renamed = path.join(watched, 'Renamed.md');
    await fs.rename(filename, renamed);
    await page.waitForFunction(() => getMemFile('/Watching/Renamed.md') && !getMemFile('/Watching/Live.md'));
    await assert.rejects(fs.stat(filename), {code: 'ENOENT'});

    await page.evaluate(async () => {
        clearInterval(window.saver);
        await openFile('/Watching/Renamed.md');
        currentEditor.setValue('# Renamed\nEdited in the browser');
    });
    await fs.writeFile(renamed, 'Edited outside the app');
    await page.evaluate(async () => { await syncCurrentFile(); });
    assert.equal(await fs.readFile(renamed, 'utf8'), 'Edited outside the app');
    const conflicts = await snapshot(path.join(notes, 'Conflicts'));
    assert.ok(Object.values(conflicts).includes('Edited in the browser'));
    await page.waitForFunction(() => currentEditor.getValue() === '# Renamed\nEdited outside the app');
    assert.match(await page.locator('#connection-notice').innerText(), /both versions are kept/);

    await fs.unlink(renamed);
    await fs.rmdir(watched);
    await page.waitForFunction(() => !getMemFile('/Watching/Renamed.md'));
    await assert.rejects(fs.stat(renamed), {code: 'ENOENT'});

    // A browser draft survives reload while the backend is unavailable.
    const context = page.context();
    await context.route('**/notes/sync', route => route.abort());
    await page.evaluate(async () => {
        await createDir('/Offline empty/nested');
        await write('/Offline.md', 'Draft saved while disconnected');
        await write('/Cancelled.md', 'Never publish this deleted draft');
        await remove('/Cancelled.md');
        await moveFile('/moved/Renamed by header.md', '/Offline move.md');
        await syncLocalFileWithServer('/Offline.md').catch(() => {});
    });
    await page.reload();
    await page.waitForFunction(() => getMemFile('/Offline.md') && !isSyncingFiles);
    assert.equal(await page.evaluate(() => read('/Offline.md')), 'Draft saved while disconnected');
    await context.unroute('**/notes/sync');
    await page.waitForFunction(() => server.initialized && !isSyncingFiles && !localDrafts['/Offline.md']);
    assert.equal(await fs.readFile(path.join(notes, 'Offline.md'), 'utf8'), 'Draft saved while disconnected');
    assert.equal((await fs.stat(path.join(notes, 'Offline empty/nested'))).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(notes, 'Offline move.md'), 'utf8'), 'Edited content');
    await assert.rejects(fs.stat(path.join(notes, 'moved/Renamed by header.md')), {code: 'ENOENT'});
    await assert.rejects(fs.stat(path.join(notes, 'Cancelled.md')), {code: 'ENOENT'});
}

async function verifyNestedFolders(page, notes) {
    const deep = Array.from({length: 14}, (_, i) => `Level ${i + 1}`).join('/') + '/Deep.md';
    for (const name of [deep, 'Projects/Shared/One.md', 'Archive/Shared/Two.md', '<b>literal/Note.md']) {
        await fs.mkdir(path.dirname(path.join(notes, name)), {recursive: true});
        await fs.writeFile(path.join(notes, name), 'Nested note content');
    }
    await fs.mkdir(path.join(notes, 'Empty from disk'));
    await page.waitForFunction(deep => !isSyncingFiles && getMemFile('/' + deep), deep);
    const result = await page.evaluate(async deep => {
        files = await loadLocalFiles(await getRootDirHandle());
        renderSidebar();
        function find(path, node = tree.getRoot()) {
            if (node.path === path) return node;
            for (const child of node.getChildren()) {
                const found = find(path, child);
                if (found) return found;
            }
        }
        find('/Projects').setExpanded(true);
        find('/Projects/Shared').setExpanded(true);
        find('/Archive').setExpanded(true);
        find('/Archive/Shared').setExpanded(false);
        renderSidebar();
        const separate = find('/Projects/Shared').isExpanded() && !find('/Archive/Shared').isExpanded();
        await openFile('/' + deep);
        const parents = [];
        for (let node = find('/' + deep).parent; node.path !== '/'; node = node.parent) {
            parents.push({path: node.path, expanded: node.isExpanded()});
        }
        return {separate, parents, empty: !!find('/Empty from disk')};
    }, deep);
    assert.equal(result.separate, true, 'Repeated folder names must have independent state');
    assert.equal(result.empty, true);
    assert.equal(result.parents.length, 14);
    assert.ok(result.parents.every(node => node.expanded));
    assert.match(await page.locator('#tree').innerText(), /Deep/);
    assert.equal(await page.locator('#tree b').count(), 0, 'Folder names are text, not HTML');
    await page.reload();
    await waitForSync(page);
    assert.match(await page.locator('#tree').innerText(), /Deep/, 'Expanded ancestors must survive reload');
    assert.match(await page.locator('#tree').innerText(), /One/);
    assert.doesNotMatch(await page.locator('#tree').innerText(), /Two/);
    await page.evaluate(async deep => {
        clearInterval(window.saver);
        await openFile('/' + deep);
        currentEditor.replaceRange('Edited ', {line: 1, ch: 0});
        await loadLocalFiles(await getRootDirHandle()); // A dirty editor must not block directory scans.
        await syncCurrentFile();
    }, deep);
    assert.equal(await fs.readFile(path.join(notes, deep), 'utf8'), 'Edited Nested note content');
    await page.evaluate(async () => { currentEditor.markClean(); await openChat(); });
}

async function verifyExactContents(page, notes) {
    const file = path.join(notes, 'Hash.md');
    await fs.writeFile(file, 'Aa');
    await page.waitForFunction(() => !isSyncingFiles && getMemFile('/Hash.md'));
    const version = await page.evaluate(() => getServerFile('/Hash.md').version);
    // Aa and BB collide under the old 32-bit hash. Disk updates still apply.
    await fs.writeFile(file, 'BB');
    await page.waitForFunction(version => !isSyncingFiles && getServerFile('/Hash.md').version !== version, version);
    assert.equal(await page.evaluate(() => read('/Hash.md')), 'BB');
    // Edits made directly to a browser folder must be detected as well.
    await page.evaluate(async () => {
        const writable = await (await getFileHandle('/Hash.md')).createWritable();
        await writable.write('Aa');
        await writable.close();
        await syncFilesWithServer();
    });
    assert.equal(await fs.readFile(file, 'utf8'), 'Aa');
    const nextVersion = await page.evaluate(() => getServerFile('/Hash.md').version);
    await fs.writeFile(file, 'Line one\r\nLine two');
    await page.waitForFunction(version => !isSyncingFiles && getServerFile('/Hash.md').version !== version, nextVersion);
    assert.equal(await page.evaluate(() => read('/Hash.md')), 'Line one\r\nLine two');
}

async function verifyFolderOperations(page, notes) {
    await page.evaluate(async () => { await createDir('/New empty/nested'); await syncFilesWithServer(); });
    assert.equal((await fs.stat(path.join(notes, 'New empty/nested'))).isDirectory(), true);
    await page.evaluate(async () => { await removeDir('/New empty'); await syncFilesWithServer(); });
    await assert.rejects(fs.stat(path.join(notes, 'New empty')), {code: 'ENOENT'});

    await fs.mkdir(path.join(notes, 'Move folder/nested/empty'), {recursive: true});
    await fs.writeFile(path.join(notes, 'Move folder/nested/Note.md'), 'Move safely');
    await fs.mkdir(path.join(notes, 'Unlisted'));
    await fs.writeFile(path.join(notes, 'Unlisted/keep.txt'), 'Preserve unsupported files');
    await page.waitForFunction(() => !isSyncingFiles && getMemFile('/Move folder/nested/Note.md'));
    await page.evaluate(async () => { await moveDir('/Move folder', '/Moved folder'); await syncFilesWithServer(); });
    assert.equal(await fs.readFile(path.join(notes, 'Moved folder/nested/Note.md'), 'utf8'), 'Move safely');
    assert.equal((await fs.stat(path.join(notes, 'Moved folder/nested/empty'))).isDirectory(), true);
    await assert.rejects(fs.stat(path.join(notes, 'Move folder')), {code: 'ENOENT'});
    await page.evaluate(async () => { await removeDir('/Unlisted'); await syncFilesWithServer(); });
    assert.equal(await fs.readFile(path.join(notes, 'Unlisted/keep.txt'), 'utf8'), 'Preserve unsupported files');

    const protectedSource = await page.evaluate(async () => {
        const original = writeIfContentIsDifferent;
        writeIfContentIsDifferent = async () => { throw new Error('Simulated move write failure'); };
        let failed = false;
        try { await moveDir('/Moved folder', '/Failed move'); }
        catch { failed = true; }
        finally { writeIfContentIsDifferent = original; }
        return failed && await read('/Moved folder/nested/Note.md') === 'Move safely'
            && !pendingFileDeletes.has('/Moved folder/nested/Note.md');
    });
    assert.equal(protectedSource, true);
    await page.evaluate(async () => { await syncFilesWithServer(); });
    assert.equal(await fs.readFile(path.join(notes, 'Moved folder/nested/Note.md'), 'utf8'), 'Move safely');

    const refusedOverwrite = await page.evaluate(async () => {
        try { await moveFile('/Moved folder/nested/Note.md', '/Help.md'); }
        catch { return await read('/Help.md') === 'My own help note'; }
        return false;
    });
    assert.equal(refusedOverwrite, true);
}

async function verifyFocusDuringRename(page, notes) {
    await page.evaluate(async () => {
        clearInterval(window.saver);
        await write('/Focus source.md', 'Source body');
        await write('/Focus other.md', 'Other pane body');
        await syncLocalNotes();
        await openFile('/Focus source.md');
        await openFile('/Focus other.md', false, 'editor2-textarea');
        editor.focus();
        // Let focus handlers queued while openFile held its lock settle before
        // selecting the initiating pane. Otherwise syncCurrentFile can safely
        // no-op and the test would wait forever for an interceptor never reached.
        await new Promise(resolve => setTimeout(resolve, 50));
        currentEditor = editor;
        editor.setValue('# Focus renamed\nSource body');
        const original = getFileHandle;
        let release, arrived;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { arrived = resolve; });
        let held = false;
        getFileHandle = async (path, create) => {
            if (path === '/Focus renamed.md' && create && !held) {
                held = true; arrived(); await gate;
            }
            return original(path, create);
        };
        try {
            const saving = syncCurrentFile();
            await waitForSafetyGate(reached, saving, 'rename destination');
            editor2.focus();
            await new Promise(resolve => setTimeout(resolve, 50));
            if (currentEditor !== editor) throw new Error('Focus changed the editor during rename');
            release();
            await saving;
        } finally { release(); getFileHandle = original; }
        await syncLocalNotes();
        currentEditor.markClean();
        await openChat();
    });
    assert.equal(await fs.readFile(path.join(notes, 'Focus renamed.md'), 'utf8'), 'Source body');
    assert.equal(await fs.readFile(path.join(notes, 'Focus other.md'), 'utf8'), 'Other pane body');
    await assert.rejects(fs.stat(path.join(notes, 'Focus source.md')), {code: 'ENOENT'});
}

async function verifyTitleRecoveryAndSplitPane(page, notes) {
    await page.evaluate(async () => {
        await write('/Title crash.md', 'Body survives title changes');
        await syncLocalNotes();
        clearInterval(window.saver);
        await openFile('/Title crash.md');
        currentEditor.replaceRange('Recovered title', {line: 0, ch: 2}, {line: 0, ch: currentEditor.getLine(0).length});
        const source = currentEditor;
        await openFile('/Title crash.md', false, 'editor2-textarea');
        if (currentEditor !== source) throw new Error('Same note opened in a second independent buffer');
        await syncLocalNotes(); // Acknowledged body must not discard pending title metadata.
        if (localDrafts['/Title crash.md']?.editorTitle !== '# Recovered title') throw new Error('Pending title was discarded');
    });
    await page.reload();
    await waitForSync(page);
    await page.evaluate(async () => {
        clearInterval(window.saver);
        await openFile('/Title crash.md');
        if (currentEditor.getLine(0) !== '# Recovered title') throw new Error('Title did not survive reload');
        await syncCurrentFile();
        await syncLocalNotes();
        currentEditor.markClean();
        await openChat();
    });
    assert.equal(await fs.readFile(path.join(notes, 'Recovered title.md'), 'utf8'), 'Body survives title changes');
    await assert.rejects(fs.stat(path.join(notes, 'Title crash.md')), {code: 'ENOENT'});
}

async function verifyInflightEdits(page, notes) {
    await page.evaluate(async () => {
        clearInterval(window.saver);
        await openFile('/Hash.md');
        const originalFetch = window.fetch;
        let release, arrived;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { arrived = resolve; });
        let held = false;
        window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (String(args[0]).endsWith('/notes/sync') && !held) {
                held = true;
                arrived();
                await gate;
            }
            return response;
        };
        try {
            currentEditor.setValue('# Hash\nFirst in-flight edit');
            const saving = syncLocalNotes();
            await waitForSafetyGate(reached, saving, 'write response');
            currentEditor.setValue('# Hash\nNewest in-flight edit');
            release();
            await saving;
            if (localDrafts['/Hash.md']?.content !== 'Newest in-flight edit') throw new Error('Response discarded newer typing');
        } finally { release(); window.fetch = originalFetch; }
        await syncCurrentFile();
        await openChat();
    });
    assert.equal(await fs.readFile(path.join(notes, 'Hash.md'), 'utf8'), 'Newest in-flight edit');
    await page.evaluate(async () => {
        await write('/Recreated.md', 'Original before deletion');
        await syncLocalNotes();
        await remove('/Recreated.md');
        const originalFetch = window.fetch;
        let release, arrived;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { arrived = resolve; });
        let held = false;
        window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (String(args[0]).endsWith('/notes/sync') && !held) {
                held = true; arrived(); await gate;
            }
            return response;
        };
        try {
            const deleting = syncLocalNotes();
            await waitForSafetyGate(reached, deleting, 'deletion response');
            await write('/Recreated.md', 'Recreated while deletion was in flight');
            release();
            await deleting;
            if (localDrafts['/Recreated.md']?.content !== 'Recreated while deletion was in flight') throw new Error('Response discarded recreated note');
        } finally { release(); window.fetch = originalFetch; }
        await syncLocalNotes();
    });
    assert.equal(await fs.readFile(path.join(notes, 'Recreated.md'), 'utf8'), 'Recreated while deletion was in flight');
}

async function verifyPushEvents(page, notes) {
    await page.waitForFunction(() => localWatchConnected);
    await page.evaluate(async () => {
        clearInterval(localSyncTimer);
        clearInterval(window.saver);
        await openChat();
    });
    try {
        await fs.writeFile(path.join(notes, 'Pushed.md'), 'Pushed without browser polling');
        await page.waitForFunction(() => getMemFile('/Pushed.md'), null, {timeout: 5000});
        assert.equal(await page.evaluate(() => read('/Pushed.md')), 'Pushed without browser polling');
        await page.evaluate(() => localWatchController.abort());
        await page.waitForFunction(() => !localWatchConnected);
        await fs.writeFile(path.join(notes, 'Pushed.md'), 'Changed during reconnect');
        await page.waitForFunction(() => localWatchConnected);
        await page.waitForFunction(async () => await read('/Pushed.md') === 'Changed during reconnect');
    } finally {
        await page.evaluate(() => {
            localSyncTimer = setInterval(() => { if (!isSyncingFiles) syncLocalNotes().catch(() => {}); }, 2000);
        });
    }
}

async function verifyDurableConcurrentDrafts(page, notes) {
    await fs.writeFile(path.join(notes, 'Concurrent.md'), 'Original concurrent note');
    await page.waitForFunction(() => !isSyncingFiles && getMemFile('/Concurrent.md'));
    const context = page.context();
    const first = await context.newPage();
    const second = await context.newPage();
    for (const tab of [first, second]) {
        await tab.goto(page.url());
        await waitForSync(tab);
        await tab.evaluate(async () => {
            clearInterval(window.saver);
            await openFile('/Concurrent.md');
        });
    }
    await context.route('**/notes/sync', route => route.abort());
    await context.route('**/notes/events', route => route.abort());
    for (const [tab, content] of [[first, 'First tab unsaved keystrokes'], [second, 'Second tab unsaved keystrokes']]) {
        const durable = await tab.evaluate(content => {
            currentEditor.setValue('# Concurrent\n' + content);
            return Object.keys(localStorage).some(key => key.startsWith(LOCAL_JOURNAL_PREFIX) &&
                JSON.parse(localStorage.getItem(key)).draft.content === content);
        }, content);
        assert.equal(durable, true, 'Typing must reach durable storage before autosave or unload');
    }
    // Close without beforeunload: a crash/mobile eviction need not run it.
    await first.close({runBeforeUnload: false});
    await second.close({runBeforeUnload: false});
    await page.reload();
    await page.waitForFunction(() => !isSyncingFiles && Object.keys(localDrafts).length >= 2);
    const recovered = await page.evaluate(() => Object.values(localDrafts).map(draft => draft.content));
    assert.ok(recovered.includes('First tab unsaved keystrokes'));
    assert.ok(recovered.includes('Second tab unsaved keystrokes'));
    await context.unroute('**/notes/sync');
    await context.unroute('**/notes/events');
    await page.evaluate(() => syncLocalNotes());
    const saved = Object.values(await snapshot(notes));
    assert.ok(saved.includes('First tab unsaved keystrokes'));
    assert.ok(saved.includes('Second tab unsaved keystrokes'));
}

async function verifyStorageFailure(page) {
    await page.evaluate(async () => {
        clearInterval(window.saver);
        await openFile('/Hash.md');
    });
    const result = await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (key.startsWith(LOCAL_JOURNAL_PREFIX)) throw new DOMException('Quota exceeded', 'QuotaExceededError');
            return original.call(this, key, value);
        };
        try {
            currentEditor.setValue('# Hash\nKeep this text when storage fails');
            return {content: currentEditor.getValue(), failed: localDraftStorageFailed,
                notice: document.getElementById('connection-notice').textContent};
        } finally { Storage.prototype.setItem = original; }
    });
    assert.equal(result.failed, true);
    assert.match(result.notice, /Keep this tab open/);
    assert.match(result.content, /Keep this text/);
    await page.evaluate(async () => { await syncCurrentFile(); await openChat(); });
}

async function runCase(binary, browserType, volatile, empty) {
    const label = `${browserType.name()} / ${volatile ? 'forced memory' : 'default storage'} / ${empty ? 'empty' : 'existing'} folder`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'files-md-safety-'));
    const notes = path.join(root, 'notes');
    await fs.mkdir(notes);
    await fs.mkdir(path.join(root, 'tokens'));
    await fs.symlink(path.join(repo, 'web'), path.join(root, 'web'));
    const baseline = empty ? {} : originals;
    for (const [name, content] of Object.entries(baseline)) {
        await fs.mkdir(path.dirname(path.join(notes, name)), {recursive: true});
        await fs.writeFile(path.join(notes, name), content);
    }
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(binary, [], {
        cwd: root,
        env: {
            ...process.env,
            HTTP_ADDR: `0.0.0.0:${port}`, APP_URL: url, API_URL: url,
            NOTES_DIR: notes, NOTES_BACKUP_DIR: path.join(root, 'backups'),
            TOKENS_DIR: path.join(root, 'tokens'), STORAGE_DIR: path.join(root, 'storage'),
            LOG_FILE: path.join(root, 'server.log'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    const logs = [];
    const errors = [];
    child.stderr.on('data', data => logs.push(data.toString()));
    const exited = new Promise(resolve => child.once('exit', resolve));
    let browser;
    let page;
    let passed = false;
    let currentPhase = 'server startup';
    const startedAt = Date.now();
    const phase = async name => {
        currentPhase = name;
        const detail = {label, phase: name, elapsedMs: Date.now() - startedAt};
        logs.push(JSON.stringify(detail));
        await fs.writeFile(path.join(root, 'phase.json'), JSON.stringify(detail, null, 2));
        console.log(`PHASE ${label}: ${name}`);
    };
    const run = async () => {
        await phase('server startup');
        await waitForServer(child, url, root);
        const listeners = await promisify(execFile)('ss', ['-ltn']);
        assert.ok(listeners.stdout.includes(`0.0.0.0:${port}`), 'Test server must listen on all IPv4 interfaces');
        const executablePath = browserType === chromium ? process.env.CHROMIUM_BIN : process.env.FIREFOX_BIN;
        await phase('browser startup');
        browser = await browserType.launch({headless: true, ...(executablePath ? {executablePath} : {})});
        const context = await browser.newContext({serviceWorkers: browserType === chromium && !volatile && !empty ? 'allow' : 'block'});
        await context.addInitScript(() => {
            window.waitForSafetyGate = async (gate, operation, label) => {
                let timer;
                try {
                    await Promise.race([
                        gate,
                        operation.then(() => { throw new Error(`Operation completed before test gate: ${label}`); }),
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new Error(`Timed out waiting for test gate: ${label}`)), 10000);
                        }),
                    ]);
                } finally { clearTimeout(timer); }
            };
        });
        if (volatile) {
            await context.addInitScript(() => {
                Object.defineProperty(FileSystemFileHandle.prototype, 'createWritable', {value: undefined, configurable: true});
            });
        }
        page = await context.newPage();
        page.on('pageerror', error => errors.push(error.stack || error.message));
        page.on('console', message => logs.push(message.text()));
        page.on('dialog', dialog => {
            errors.push(`Unexpected dialog: ${dialog.message()}`);
            dialog.dismiss();
        });
        await phase('authentication and startup');
        // A plain link in a fresh browser must explain that login is needed.
        // Probing the session must not ban the subsequent authenticated sync.
        await page.goto(url);
        await page.waitForFunction(() =>
            !document.getElementById('connection-notice').hidden);
        assert.match(await page.locator('#connection-notice').innerText(), /Sign in/);
        await assertNoSamples(page);
        assert.deepEqual(await snapshot(notes), baseline);
        await page.goto((await fs.readFile(path.join(root, 'login-url'), 'utf8')).trim());
        await waitForSync(page);
        assert.equal(await page.locator('#connection-notice').isVisible(), false);
        if (browserType === chromium && !volatile && !empty) {
            await page.evaluate(() => navigator.serviceWorker.ready);
            await page.reload();
            await waitForSync(page);
            assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
        }
        await assertNoSamples(page);
        assert.deepEqual(await snapshot(notes), baseline, 'Startup changed the supplied folder');

        await phase('blur and reload');
        // Exercise the original trigger: downloading files, then a blur sync.
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/notes/sync')),
            page.evaluate(() => window.dispatchEvent(new Event('blur'))),
        ]);
        await waitForSync(page);
        assert.deepEqual(await snapshot(notes), baseline, 'Blur sync changed untouched files');
        // Reproduce a different port/new origin: retain the valid cookie but
        // remove all browser-local connection markers and server cursors.
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await waitForSync(page);
        assert.equal(await page.locator('#connection-notice').isVisible(), false);
        await page.evaluate(async () => {
            files = await loadLocalFiles(await getRootDirHandle());
            await syncFilesWithServer();
        });
        await assertNoSamples(page);
        assert.deepEqual(await snapshot(notes), baseline, 'Reload or repeated sync changed the supplied folder');

        await phase(empty ? 'first note' : 'mutation safety');
        if (empty) {
            // Empty first sync must still initialize the server snapshot.
            await page.evaluate(async () => {
                await write('/First.md', 'My first real note');
                files = await loadLocalFiles(await getRootDirHandle());
                await syncFilesWithServer();
            });
            assert.deepEqual(await snapshot(notes), {'First.md': 'My first real note'});
        } else {
            const statuses = await page.evaluate(async () => ({
                md: (await getFileStatus('/Original.md')).status,
                txt: (await getFileStatus('/Plain.md')).status,
                memory: (await getFileHandle('/Original.md')) instanceof MemFile,
            }));
            assert.equal(statuses.md, 'notModified');
            assert.equal(statuses.txt, 'notModified');
            if (volatile) assert.equal(statuses.memory, true);

            // A missing browser entry is not evidence of a user deletion.
            await page.evaluate(async () => {
                removeMemFile('/Original.md');
                await syncFilesWithServer();
                files = await loadLocalFiles(await getRootDirHandle());
            });
            assert.deepEqual(await snapshot(notes), baseline);

            // A read error aborts before transmitting any changes and releases the lock.
            const aborted = await page.evaluate(async () => {
                const original = getFileStatus;
                getFileStatus = async () => ({status: 'error'});
                try { await syncFilesWithServer(); return false; }
                catch { return !isSyncingFiles; }
                finally { getFileStatus = original; }
            });
            assert.equal(aborted, true);
            assert.deepEqual(await snapshot(notes), baseline);

            await page.evaluate(async () => {
                await write('/Original.md', 'Edited content');
                await syncLocalFileWithServer('/Original.md');
            });
            assert.equal(await fs.readFile(path.join(notes, 'Original.md'), 'utf8'), 'Edited content');
            const backups = await snapshot(path.join(root, 'backups', 'Original.md'));
            assert.ok(Object.values(backups).includes('Original content'));

            await page.evaluate(async () => {
                await remove('/Plain.md');
                await syncFilesWithServer();
            });
            await assert.rejects(fs.stat(path.join(notes, 'Plain.md')), {code: 'ENOENT'});
            assert.ok(Object.values(await snapshot(path.join(root, 'backups', 'Plain.md'))).includes('Plain text content'));

            // A move must send its destination even when it is open in an editor.
            await page.evaluate(async () => {
                await moveFile('/nested/Note.md', '/nested/Renamed.md');
                removeMemFile('/nested/Renamed.md');
                editor.path = '/nested/Renamed.md';
                await syncFilesWithServer();
                editor.path = undefined;
            });
            assert.equal(await fs.readFile(path.join(notes, 'nested/Renamed.md'), 'utf8'), 'Nested content');
            await assert.rejects(fs.stat(path.join(notes, 'nested/Note.md')), {code: 'ENOENT'});

            const oldStatus = await page.evaluate(async () =>
                (await fetch('/syncFilenames', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({deleted: ['nested/Renamed.md']}),
                })).status);
            assert.equal(oldStatus, 409, 'An old cached client must be rejected before mutation');
            assert.equal(await fs.readFile(path.join(notes, 'nested/Renamed.md'), 'utf8'), 'Nested content');

            // Move the open note with the other UI path, then rename its header.
            await page.evaluate(async () => {
                clearInterval(window.saver);
                await openFile('/Original.md');
                await moveCurrentFile('/moved');
                await syncFilesWithServer();
            });
            assert.equal(await fs.readFile(path.join(notes, 'moved/Original.md'), 'utf8'), 'Edited content');
            await assert.rejects(fs.stat(path.join(notes, 'Original.md')), {code: 'ENOENT'});
            // Simulate failure after a new filename was accepted but before its
            // content could be written. Both local and server originals survive.
            const sourceSurvived = await page.evaluate(async () => {
                currentEditor.setValue('# Renamed by header\nEdited content');
                const original = writeIfContentIsDifferent;
                writeIfContentIsDifferent = async () => { throw new Error('Simulated disk write failure'); };
                try {
                    await syncCurrentFile();
                    return currentEditor.path === '/moved/Original.md'
                        && await read('/moved/Original.md') === 'Edited content'
                        && !pendingFileDeletes.has('/moved/Original.md');
                } finally {
                    writeIfContentIsDifferent = original;
                }
            });
            assert.equal(sourceSurvived, true);
            assert.equal(await fs.readFile(path.join(notes, 'moved/Original.md'), 'utf8'), 'Edited content');
            await page.evaluate(async () => {
                await syncCurrentFile();
                await syncFilesWithServer();
                currentEditor.markClean();
                await openChat();
            });
            assert.equal(await fs.readFile(path.join(notes, 'moved/Renamed by header.md'), 'utf8'), 'Edited content');
            await assert.rejects(fs.stat(path.join(notes, 'moved/Original.md')), {code: 'ENOENT'});
        }
        if (!empty) {
            const checks = [
                verifyLiveChanges, verifyNestedFolders, verifyFolderOperations,
                verifyExactContents, verifyFocusDuringRename, verifyTitleRecoveryAndSplitPane,
                verifyInflightEdits, verifyPushEvents, verifyStorageFailure,
                verifyDurableConcurrentDrafts, verifyArchiveSafety,
            ];
            for (const check of checks) {
                await phase(check.name);
                await check(page, notes);
            }
        }
        if (browserType === chromium && !volatile && !empty) {
            await phase('verifyFolderPicker');
            await verifyFolderPicker(page);
        }
        assert.deepEqual(errors, []);
        passed = true;
        console.log(`PASS ${label}`);
    };
    try {
        await withTimeout(run(), fixtureTimeoutMs, `Fixture exceeded ${fixtureTimeoutMs}ms: ${label}`);
    } catch (error) {
        await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify({
            label, phase: currentPhase, elapsedMs: Date.now() - startedAt,
            error: error.stack || String(error), errors,
        }, null, 2));
        await fs.writeFile(path.join(root, 'browser.log'), logs.join('\n'));
        console.error(`FAIL ${label} during ${currentPhase}; fixture retained: ${root}`, error, errors);
        throw error;
    } finally {
        // Closing the browser rejects any outstanding page.evaluate and releases
        // injected gates. Never let a hung cleanup hide the original failure.
        if (browser) {
            try { await withTimeout(browser.close(), 5000, 'Browser cleanup timed out'); }
            catch (error) { console.error(`Cleanup ${label}: ${error.message}`); }
        }
        child.kill('SIGTERM');
        try { await withTimeout(exited, 3000, 'Test server cleanup timed out'); }
        catch {
            child.kill('SIGKILL');
            await withTimeout(exited, 3000, 'Test server did not exit after SIGKILL');
        }
        if (passed) await fs.rm(root, {recursive: true, force: true});
    }
}

(async () => {
    let binary = process.argv[2] && path.resolve(process.argv[2]);
    if (!binary) {
        const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'files-md-safety-build-'));
        binary = path.join(buildDir, 'server');
        await promisify(execFile)('go', ['build', '-o', binary, './cmd/local-server'], {cwd: repo});
    }
    const cases = [];
    for (const empty of [false, true]) {
        if (process.env.BROWSER !== 'firefox') {
            cases.push(() => runCase(binary, chromium, false, empty), () => runCase(binary, chromium, true, empty));
        }
        if (process.env.BROWSER !== 'chromium') {
            cases.push(() => runCase(binary, firefox, false, empty), () => runCase(binary, firefox, true, empty));
        }
    }
    for (let i = 0; i < cases.length; i += 4) {
        const results = await Promise.allSettled(cases.slice(i, i + 4).map(run => run()));
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Safety regression failed');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
