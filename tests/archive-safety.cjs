const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function verifyArchiveSafety(page, notes) {
    await page.evaluate(async () => {
        clearInterval(window.saver);
        await write('/Archive immediately.md', 'Saved before typing');
        files = await loadLocalFiles(await getRootDirHandle());
        await syncFilesWithServer();
        await openFile('/Archive immediately.md');
        currentEditor.setValue('# Archive immediately\nLast keystrokes before archive');
        await removeCurrentFile();
        await syncFilesWithServer();
    });
    assert.equal(await fs.readFile(path.join(notes, 'archive/Archive immediately.md'), 'utf8'), 'Last keystrokes before archive');
    await assert.rejects(fs.stat(path.join(notes, 'Archive immediately.md')), {code: 'ENOENT'});

    const failureState = await page.evaluate(async () => {
        await write('/Archive failure.md', 'Original');
        files = await loadLocalFiles(await getRootDirHandle());
        await syncFilesWithServer();
        await openFile('/Archive failure.md');
        currentEditor.setValue('# Archive failure\nKeep my pending edit');
        const original = writeIfContentIsDifferent;
        writeIfContentIsDifferent = async (path, ...args) => {
            if (path.startsWith('/archive/')) throw new Error('Simulated archive failure');
            return original(path, ...args);
        };
        try {
            await removeCurrentFile();
            return {
                path: currentEditor.path, content: currentEditor.getValue(),
                deleted: pendingFileDeletes.has('/Archive failure.md'),
                locked: isMessingWithCurrentEditor,
            };
        } finally { writeIfContentIsDifferent = original; }
    });
    assert.deepEqual(failureState, {
        path: '/Archive failure.md', content: '# Archive failure\nKeep my pending edit',
        deleted: false, locked: false,
    });
    assert.ok(['Original', 'Keep my pending edit'].includes(await fs.readFile(path.join(notes, 'Archive failure.md'), 'utf8')));

    await page.evaluate(async () => {
        await openFile('/archive/Archive immediately.md');
        const original = window.confirm;
        window.confirm = () => false;
        try { await removeCurrentFile(); } finally { window.confirm = original; }
        await syncFilesWithServer();
    });
    assert.equal(await fs.readFile(path.join(notes, 'archive/Archive immediately.md'), 'utf8'), 'Last keystrokes before archive');
    await page.evaluate(async () => {
        const original = window.confirm;
        window.confirm = () => true;
        try { await removeCurrentFile(); } finally { window.confirm = original; }
        await syncFilesWithServer();
    });
    await assert.rejects(fs.stat(path.join(notes, 'archive/Archive immediately.md')), {code: 'ENOENT'});
    const backupDir = path.join(path.dirname(notes), 'backups/archive/Archive immediately.md');
    const backups = await Promise.all((await fs.readdir(backupDir)).map(name => fs.readFile(path.join(backupDir, name), 'utf8')));
    assert.ok(backups.includes('Last keystrokes before archive'));

    await page.evaluate(async () => {
        await write('/Moving folder/Unsaved.md', 'Old mirror');
        files = await loadLocalFiles(await getRootDirHandle());
        await syncFilesWithServer();
        await openFile('/Moving folder/Unsaved.md');
        currentEditor.setValue('# Unsaved\nLatest edit before folder move');
        await moveDir('/Moving folder', '/Moved folder');
        if (currentEditor.path !== '/Moved folder/Unsaved.md') throw new Error('Moved editor still points at source');
        await syncFilesWithServer();
    });
    assert.equal(await fs.readFile(path.join(notes, 'Moved folder/Unsaved.md'), 'utf8'), 'Latest edit before folder move');
    await assert.rejects(fs.stat(path.join(notes, 'Moving folder/Unsaved.md')), {code: 'ENOENT'});

    const panes = await page.evaluate(async () => {
        await write('/Move focus.md', 'First pane');
        await write('/Other pane.md', 'Second pane');
        files = await loadLocalFiles(await getRootDirHandle());
        await syncFilesWithServer();
        await openFile('/Other pane.md', true, 'editor2-textarea');
        await openFile('/Move focus.md');
        const original = writeIfContentIsDifferent;
        writeIfContentIsDifferent = async (...args) => {
            const result = await original(...args);
            currentEditor = editor2;
            return result;
        };
        try { await moveCurrentFile('/Focus moved'); }
        finally { writeIfContentIsDifferent = original; }
        await syncFilesWithServer();
        return {first: editor.path, second: editor2.path};
    });
    assert.deepEqual(panes, {first: '/Focus moved/Move focus.md', second: '/Other pane.md'});
    assert.equal(await fs.readFile(path.join(notes, 'Focus moved/Move focus.md'), 'utf8'), 'First pane');
    assert.equal(await fs.readFile(path.join(notes, 'Other pane.md'), 'utf8'), 'Second pane');
};
