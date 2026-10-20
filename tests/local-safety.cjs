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

const repo = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const originals = {
    'Original.md': 'Original content',
    'Plain.txt': 'Plain text content',
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
        socket.listen(0, '127.0.0.1', resolve);
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
            HTTP_ADDR: `127.0.0.1:${port}`, APP_URL: url, API_URL: url,
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
    try {
        await waitForServer(child, url, root);
        const executablePath = browserType === chromium ? process.env.CHROMIUM_BIN : process.env.FIREFOX_BIN;
        browser = await browserType.launch({headless: true, ...(executablePath ? {executablePath} : {})});
        const context = await browser.newContext({serviceWorkers: 'block'});
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
        await assertNoSamples(page);
        assert.deepEqual(await snapshot(notes), baseline, 'Startup changed the supplied folder');

        // Exercise the original trigger: downloading files, then a blur sync.
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/syncFilenames')),
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
                txt: (await getFileStatus('/Plain.txt')).status,
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
                await remove('/Plain.txt');
                await syncFilesWithServer();
            });
            await assert.rejects(fs.stat(path.join(notes, 'Plain.txt')), {code: 'ENOENT'});
            assert.ok(Object.values(await snapshot(path.join(root, 'backups', 'Plain.txt'))).includes('Plain text content'));

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
        if (browserType === chromium && !volatile && !empty) await verifyFolderPicker(page);
        assert.deepEqual(errors, []);
        passed = true;
        console.log(`PASS ${label}`);
    } catch (error) {
        await fs.writeFile(path.join(root, 'browser.log'), logs.join('\n'));
        console.error(`FAIL ${label}; fixture retained: ${root}`, errors);
        throw error;
    } finally {
        if (browser) await browser.close();
        child.kill('SIGTERM');
        await exited;
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
    for (const empty of [false, true]) {
        if (process.env.BROWSER !== 'firefox') {
            await runCase(binary, chromium, false, empty);
            await runCase(binary, chromium, true, empty);
        }
        if (process.env.BROWSER !== 'chromium') {
            await runCase(binary, firefox, false, empty);
            await runCase(binary, firefox, true, empty);
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
