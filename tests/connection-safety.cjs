const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function waitConnected(page) {
    await page.waitForFunction(() => (localSyncTimer || (hasSelectedDiskFolder() && currentEditor?.path)) && canModifyWorkspace() && !isSyncingFiles && !isMessingWithCurrentEditor);
}

async function verifyLockedWorkspace(page) {
    await page.waitForFunction(() => localSyncTimer && !isSyncingFiles && !isMessingWithCurrentEditor);
    assert.equal(await page.evaluate(() => canModifyWorkspace()), false);
    assert.equal(await page.locator('#new-file').isDisabled(), true);
    assert.equal(await page.locator('#new-folder').isDisabled(), true);
    // Seed a browser-only fixture through raw storage handles. This simulates
    // cached notes; product mutation helpers must still refuse every operation.
    const result = await page.evaluate(async () => {
        const root = await getRootDirHandle();
        const handle = await root.getFileHandle('Locked.md', {create: true});
        const writer = await handle.createWritable();
        await writer.write('Cached text must remain unchanged');
        await writer.close();
        await root.getDirectoryHandle('Locked folder', {create: true});
        files = await loadLocalFiles(root);
        await openFile('/Locked.md');
        const prompt = window.prompt;
        const confirm = window.confirm;
        window.prompt = () => 'Forbidden folder';
        window.confirm = () => true;
        const operations = [
            () => newFile(), () => newFolder(),
            () => write('/Locked.md', 'Forbidden write'),
            () => writeAtEnd('/Locked.md', 'Forbidden append'),
            () => writeIfContentIsDifferent('/Locked.md', 'Forbidden replacement'),
            () => createDir('/Forbidden folder'),
            () => remove('/Locked.md'),
            () => rename('/Locked.md', '/Renamed.md'),
            () => moveFile('/Locked.md', '/Moved.md'),
            () => moveCurrentFile('/Forbidden folder'),
            () => removeCurrentFile(),
            () => removeDir('/Locked folder'),
            () => moveDir('/Locked folder', '/Moved folder'),
        ];
        try {
            for (const operation of operations) {
                try { await operation(); } catch {}
            }
            const names = [];
            for await (const entry of root.values()) names.push(entry.name);
            return {
                names: names.sort(),
                text: await (await handle.getFile()).text(),
                readOnly: currentEditor.getOption('readOnly'),
                draftCount: Object.keys(localDrafts).length,
            };
        } finally {
            window.prompt = prompt;
            window.confirm = confirm;
        }
    });
    assert.deepEqual(result, {
        names: ['Locked folder', 'Locked.md'], text: 'Cached text must remain unchanged',
        readOnly: true, draftCount: 0,
    });
    await page.evaluate(() => currentEditor.focus());
    await page.keyboard.type('Typing must be blocked');
    assert.equal(await page.evaluate(() => currentEditor.getValue()), '# Locked\nCached text must remain unchanged');
    await page.evaluate(async () => {
        const root = await getRootDirHandle();
        await root.removeEntry('Locked.md');
        await root.removeEntry('Locked folder');
        currentEditor.path = undefined;
        files = await loadLocalFiles(root);
    });
}

async function verifyUnavailableFolder(page, notes) {
    const tab = await page.context().newPage();
    const unavailable = notes + '-temporarily-unavailable';
    await fs.rename(notes, unavailable);
    try {
        await tab.goto(page.url());
        await tab.waitForFunction(() => localSyncTimer && localSyncFailed && !isSyncingFiles);
        await verifyLockedWorkspace(tab);
    } finally {
        await fs.rename(unavailable, notes);
    }
    try {
        await tab.evaluate(() => syncLocalNotes());
        await waitConnected(tab);
        assert.equal(await tab.locator('#new-file').isDisabled(), false);
    } finally { await tab.close(); }
}

async function verifyProjectTabs(page, notes) {
    for (const project of ['One', 'Two']) {
        await fs.mkdir(path.join(notes, 'Tab projects', project), {recursive: true});
        await fs.writeFile(path.join(notes, 'Tab projects', project, 'Notes.md'), project + ' original');
    }
    const context = page.context();
    const tabs = [await context.newPage(), await context.newPage()];
    try {
        await Promise.all(tabs.map(tab => tab.goto(page.url())));
        await Promise.all(tabs.map(waitConnected));
        const ids = await Promise.all(tabs.map(tab => tab.evaluate(() => localMirrorID)));
        assert.notEqual(ids[0], ids[1], 'Tabs need independent browser mirrors');
        await Promise.all(tabs.map((tab, i) => tab.evaluate(async project => {
            clearInterval(window.saver);
            await openFile('/Tab projects/' + project + '/Notes.md');
            currentEditor.setValue('# Notes\n' + project + ' independently edited');
            await syncCurrentFile();
        }, i === 0 ? 'One' : 'Two')));
        for (const [i, project] of ['One', 'Two'].entries()) {
            assert.equal(await fs.readFile(path.join(notes, 'Tab projects', project, 'Notes.md'), 'utf8'), project + ' independently edited');
            assert.equal(await tabs[i].evaluate(() => currentEditor.path), '/Tab projects/' + project + '/Notes.md');
        }
        await Promise.all(tabs.map(tab => tab.reload()));
        await Promise.all(tabs.map(waitConnected));
        for (const [i, project] of ['One', 'Two'].entries()) {
            assert.equal(await tabs[i].evaluate(() => currentEditor.path), '/Tab projects/' + project + '/Notes.md', 'Each tab restores its own note');
        }
        // Both tabs can stage different directory operations while disconnected.
        // Reloading one must not lose the other tab's pending directory change.
        await context.route('**/notes/sync', route => route.abort());
        try {
            await Promise.all(tabs.map((tab, i) => tab.evaluate(name => createDir('/Tab directories/' + name), i === 0 ? 'One' : 'Two')));
            await tabs[0].reload();
            await tabs[0].waitForFunction(() => localSyncTimer && !isSyncingFiles);
            assert.equal(await tabs[0].evaluate(() => canModifyWorkspace()), false);
        } finally { await context.unroute('**/notes/sync'); }
        await Promise.all(tabs.map(tab => tab.evaluate(async () => { await syncLocalNotes(); await syncLocalNotes(); })));
        await Promise.all(tabs.map(waitConnected));
        for (const project of ['One', 'Two']) assert.equal((await fs.stat(path.join(notes, 'Tab directories', project))).isDirectory(), true);
    } finally { await Promise.all(tabs.map(tab => tab.close())); }
    // Closing every project tab does not remove the browser's server cookie.
    const reopened = await context.newPage();
    try {
        await reopened.goto(page.url());
        await waitConnected(reopened);
        assert.equal(await reopened.locator('#connection-notice').isVisible(), false);
    } finally { await reopened.close(); }
}

async function verifyNativeFolderTabs(page) {
    const firstLabel = await page.locator('#workspace-path').innerText();
    const second = await page.context().newPage();
    try {
        await second.goto(page.url());
        await waitConnected(second);
        assert.equal(await second.locator('#workspace-path').innerText(), firstLabel, 'A fresh tab remembers the last selected folder');
        await second.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const selected = await root.getDirectoryHandle('second-project-folder', {create: true});
            const handle = await selected.getFileHandle('Help.md', {create: true});
            const writer = await handle.createWritable();
            await writer.write('Second project disk note');
            await writer.close();
            window.showDirectoryPicker = async () => selected;
            await openDir();
        });
        assert.equal(await second.locator('#workspace-path').innerText(), 'second-project-folder');
        assert.equal(await page.evaluate(async () => (await getRootDirHandle()).name), firstLabel);
        assert.equal(await page.evaluate(() => read('/Help.md')), 'Existing help must survive opening a folder');
        assert.equal(await second.evaluate(() => read('/Help.md')), 'Second project disk note');
        await Promise.all([page.reload(), second.reload()]);
        await Promise.all([waitConnected(page), waitConnected(second)]);
        assert.equal(await page.locator('#workspace-path').innerText(), firstLabel);
        assert.equal(await second.locator('#workspace-path').innerText(), 'second-project-folder');
        await Promise.all([[page, 'First project pending text'], [second, 'Second project pending text']].map(([tab, text]) => tab.evaluate(async text => {
            clearInterval(window.saver);
            await openFile('/Help.md');
            currentEditor.setValue('# Help\n' + text);
        }, text)));
        await Promise.all([page.reload(), second.reload()]);
        await Promise.all([waitConnected(page), waitConnected(second)]);
        assert.equal(await page.evaluate(() => currentEditor.getValue()), '# Help\nFirst project pending text');
        assert.equal(await second.evaluate(() => currentEditor.getValue()), '# Help\nSecond project pending text');
        await Promise.all([page.evaluate(() => syncCurrentFile()), second.evaluate(() => syncCurrentFile())]);
        assert.equal(await page.evaluate(() => read('/Help.md')), 'First project pending text');
        assert.equal(await second.evaluate(() => read('/Help.md')), 'Second project pending text');
        await Promise.all([page.evaluate(() => write('/Only first.md', 'First folder')), second.evaluate(() => write('/Only second.md', 'Second folder'))]);
        assert.equal(await page.evaluate(() => exists('/Only second.md')), false);
        assert.equal(await second.evaluate(() => exists('/Only first.md')), false);
        const archiveConflict = await page.evaluate(async () => {
            clearInterval(window.saver);
            await openFile('/Help.md');
            currentEditor.setValue('# Help\nNative pending text must survive archive conflict');
            const handle = await (await getRootDirHandle()).getFileHandle('Help.md');
            const writer = await handle.createWritable();
            await writer.write('Independent native disk edit');
            await writer.close();
            await removeCurrentFile();
            const conflictDir = await (await getRootDirHandle()).getDirectoryHandle('Conflicts');
            const copies = [];
            for await (const handle of conflictDir.values()) {
                if (handle.kind === 'file') copies.push(await (await handle.getFile()).text());
            }
            return {original: await read('/Help.md'), archived: await exists('/archive/Help.md'), copies};
        });
        assert.equal(archiveConflict.original, 'Independent native disk edit');
        assert.equal(archiveConflict.archived, false, 'Conflicted native archive needs a new explicit action');
        assert.ok(archiveConflict.copies.includes('Native pending text must survive archive conflict'));
        await page.evaluate(async () => {
            await openFile('/Help.md');
            await removeCurrentFile();
            await write('/Move me.md', 'Native move original');
            files = await loadLocalFiles(await getRootDirHandle());
            await openFile('/Move me.md');
            currentEditor.setValue('# Move me\nLatest native edit before move');
            await moveFile('/Move me.md', '/Moved.md');
        });
        assert.equal(await page.evaluate(() => read('/archive/Help.md')), 'Independent native disk edit');
        assert.equal(await page.evaluate(() => exists('/Help.md')), false);
        assert.equal(await page.evaluate(() => read('/Moved.md')), 'Latest native edit before move');
        assert.equal(await page.evaluate(() => exists('/Move me.md')), false);
        await second.addInitScript(() => {
            FileSystemDirectoryHandle.prototype.queryPermission = async () => 'denied';
        });
        await second.reload();
        await second.waitForFunction(() => !document.getElementById('connection-notice').hidden && !isLoadingLocalFiles);
        assert.equal(await second.evaluate(() => canModifyWorkspace()), false);
        assert.equal(await second.locator('#new-file').isDisabled(), true);
        assert.equal(await second.locator('#workspace-path').innerText(), 'second-project-folder');
        assert.equal(await second.evaluate(async () => {
            try { await write('/Forbidden.md', 'Must not be created'); return false; }
            catch { return !await exists('/Forbidden.md'); }
        }), true, 'Revoked permission must not silently fall back to browser or server storage');
    } finally { await second.close(); }
}

async function verifySharedAuthorization(page) {
    const context = page.context();
    const cookies = await context.cookies();
    const tab = await context.newPage();
    try {
        await context.clearCookies();
        await tab.goto(page.url());
        await tab.waitForFunction(() => localSyncTimer && !canModifyWorkspace());
        await page.waitForFunction(() => !canModifyWorkspace());
        assert.equal(await page.locator('#new-file').isDisabled(), true);
        assert.equal(await page.evaluate(() => currentEditor.getOption('readOnly')), true);
        await context.addCookies(cookies);
        await tab.reload();
        await Promise.all([waitConnected(tab), waitConnected(page)]);
        assert.equal(await page.locator('#new-file').isDisabled(), false);
    } finally {
        await context.addCookies(cookies);
        await tab.close();
    }
}

async function verifyManyBackgroundTabs(page, notes) {
    const tabs = [];
    const errors = [];
    let streams = 0;
    try {
        // A main tab plus seven background tabs exceeds HTTP/1's usual six
        // connections per origin. Background tabs must not occupy SSE slots.
        for (let i = 0; i < 7; i++) {
            const tab = await page.context().newPage();
            tabs.push(tab);
            tab.on('pageerror', error => errors.push(error.message));
            tab.on('request', request => { if (request.url().endsWith('/notes/events')) streams++; });
            await tab.addInitScript(() => {
                Object.defineProperty(document, 'visibilityState', {get: () => window.testVisibilityState || 'hidden', configurable: true});
            });
            await tab.goto(page.url());
            await waitConnected(tab);
            assert.equal(await tab.evaluate(() => localWatchConnected), false);
        }
        assert.equal(streams, 0, 'Background tabs must not hold event streams');
        await fs.writeFile(path.join(notes, 'Foreground refresh.md'), 'Changed while tab was hidden');
        const tab = tabs[0];
        await tab.evaluate(() => {
            window.testVisibilityState = 'visible';
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await tab.waitForFunction(() => localWatchConnected && getMemFile('/Foreground refresh.md'));
        assert.equal(await tab.evaluate(() => read('/Foreground refresh.md')), 'Changed while tab was hidden');
        assert.deepEqual(errors, []);
    } finally { await Promise.all(tabs.map(tab => tab.close())); }
}

module.exports = {verifyLockedWorkspace, verifyUnavailableFolder, verifyProjectTabs, verifyNativeFolderTabs, verifySharedAuthorization, verifyManyBackgroundTabs, waitConnected};
