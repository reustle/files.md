const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function verifyNotesOnlyUI(page, notes) {
    const result = await page.evaluate(() => {
        const before = currentEditor.path;
        for (const shiftKey of [false, true]) {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey, bubbles: true,
            }));
        }
        return {
            controls: document.querySelectorAll('#chat, #chat-container, #chat-input, #mic-chat, #send-chat').length,
            loadedAssets: [...document.querySelectorAll('script[src], link[href]')]
                .map(element => element.src || element.href).filter(url => /\/chat\.(js|css)(?:\?|$)/.test(url)),
            oldCommand: typeof openChat,
            sameNote: currentEditor.path === before,
        };
    });
    assert.deepEqual(result, {controls: 0, loadedAssets: [], oldCommand: 'undefined', sameNote: true});
    assert.equal(await page.locator('#random-file, #open-folder').count(), 0);
    assert.equal(await page.locator('#workspace-path').innerText(), notes);
    // Folder searches must return file paths usable by the result click handler,
    // without treating nested directory entries as files.
    const folderResults = await page.evaluate(() => {
        const original = files;
        try {
            files = {'search-regression/': {'Example.md': {isFile: true}, 'nested/': {}}};
            searchModal.open('search-regression/');
            return [...document.querySelectorAll('#search-results li')].map(item => item.dataset.path);
        } finally {
            files = original;
            searchModal.close();
        }
    });
    assert.deepEqual(folderResults, ['/search-regression/Example.md']);
}

async function verifyFormerInbox(page, notes) {
    const filename = path.join(notes, 'Chat.md');
    assert.equal(await fs.readFile(filename, 'utf8'), '#### Existing inbox\n- [ ] Keep this existing text\n');
    await page.evaluate(() => searchModal.open('Chat'));
    assert.equal(await page.locator('#search-results li[data-path="/Chat.md"]').innerText(), 'Chat');
    await page.evaluate(() => searchModal.close());
    await page.locator('#tree .tree-item:text-is("Chat")').click();
    await page.waitForFunction(() => currentEditor.path === '/Chat.md' && !isMessingWithCurrentEditor);
    assert.equal(await page.evaluate(() => currentEditor.getValue()), '# Chat\n#### Existing inbox\n- [ ] Keep this existing text\n');

    // Home navigation must retain the last edit in a former inbox, just like
    // every other Markdown file. Opening it never reformats existing contents.
    await page.evaluate(async () => {
        clearInterval(window.saver);
        currentEditor.setValue('# Chat\nAn ordinary note with an unsaved edit');
        await openNotesHome();
        await syncLocalNotes();
    });
    assert.equal(await fs.readFile(filename, 'utf8'), 'An ordinary note with an unsaved edit');
    await page.reload();
    // The snapshot arrives before startup finishes opening the remembered note.
    // Wait for the completed initialization before simulating a user's edit.
    await page.waitForFunction(() => localSyncTimer && !isSyncingFiles && !isMessingWithCurrentEditor);
    await page.evaluate(async () => {
        clearInterval(window.saver);
        await openFile('/Chat.md');
    });
    assert.equal(await page.evaluate(() => currentEditor.getValue()), '# Chat\nAn ordinary note with an unsaved edit');
    await page.evaluate(() => {
        currentEditor.setValue('# Chat\nKeep this conflicting browser edit');
    });
    await fs.writeFile(filename, 'Independent external edit');
    await page.evaluate(() => syncCurrentFile());
    assert.equal(await fs.readFile(filename, 'utf8'), 'Independent external edit');
    const conflictDir = path.join(notes, 'Conflicts');
    const contents = await Promise.all((await fs.readdir(conflictDir)).map(name => fs.readFile(path.join(conflictDir, name), 'utf8')));
    assert.ok(contents.includes('Keep this conflicting browser edit'), 'Former inbox edits need the same conflict preservation as notes');
    await page.waitForFunction(() => currentEditor.getValue() === '# Chat\nIndependent external edit');

    // Rename through the editable title: there must be no reserved Chat path.
    await page.evaluate(async () => {
        currentEditor.setValue('# Former inbox\nIndependent external edit');
        await syncCurrentFile();
        await syncLocalNotes();
    });
    assert.equal(await fs.readFile(path.join(notes, 'Former inbox.md'), 'utf8'), 'Independent external edit');
    await assert.rejects(fs.stat(filename), {code: 'ENOENT'});
    await verifyNotesOnlyUI(page, notes);
}

async function verifyInvalidatedSave(page, notes) {
    const original = await fs.readFile(path.join(notes, 'Help.md'), 'utf8');
    const results = await page.evaluate(async () => {
        clearInterval(window.saver);
        await openFile('/Help.md');
        const cm = currentEditor;
        const originalContent = cm.getValue();
        const originalPath = cm.path;
        const originalDiskContent = await read(originalPath);
        const getRoot = getRootDirHandle;
        const writeContent = writeIfContentIsDifferent;
        const results = [];
        for (const replacement of [undefined, '/Another note.md']) {
            cm.setValue('# Help\nPreserve these pending keystrokes');
            let release, arrived, held = false, writes = 0;
            const gate = new Promise(resolve => { release = resolve; });
            const reached = new Promise(resolve => { arrived = resolve; });
            getRootDirHandle = async (...args) => {
                if (!held) { held = true; arrived(); await gate; }
                return getRoot(...args);
            };
            writeIfContentIsDifferent = async (...args) => {
                // Background hydration also checks unchanged mirrors. Count
                // attempts to change this note or write to its invalid path.
                if (!args[0] || args[0] === replacement ||
                    (args[0] === originalPath && args[1] !== originalDiskContent)) writes++;
                return writeContent(...args);
            };
            try {
                const saving = syncCurrentFile();
                await waitForSafetyGate(reached, saving, 'root directory handle');
                // Snapshots can clear or move the same editor without changing
                // the currentEditor object while the handle lookup is pending.
                cm.path = replacement;
                release();
                await saving;
                results.push({writes, locked: isMessingWithCurrentEditor,
                    content: cm.getValue(), dirty: !cm.isClean()});
            } finally {
                release();
                getRootDirHandle = getRoot;
                writeIfContentIsDifferent = writeContent;
                cm.path = originalPath;
            }
        }
        cm.setValue(originalContent);
        await syncCurrentFile();
        return results;
    });
    assert.deepEqual(results, Array.from({length: 2}, () => ({
        writes: 0, locked: false, content: '# Help\nPreserve these pending keystrokes', dirty: true,
    })));
    assert.equal(await fs.readFile(path.join(notes, 'Help.md'), 'utf8'), original);
}

module.exports = {verifyNotesOnlyUI, verifyFormerInbox, verifyInvalidatedSave};
