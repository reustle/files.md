// Local-server sync uses complete directory snapshots and SHA-256 versions.
// Browser absence never asks the server to delete a file. Only remove() does.
const LOCAL_DRAFT_KEY = 'notes-drafts-v3:' + API_URL;
let localDrafts = JSON.parse(localStorage.getItem(LOCAL_DRAFT_KEY) || '{}');
let localNotesInitialized = false;
let localSyncTimer = null;
let localSyncFailed = false;

function isNotePath(path) { return /\.md$/i.test(path); }

function persistLocalDrafts() {
    localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(localDrafts));
}

function stageLocalDraft(path, content, version) {
    if (!window.FILES_MD_LOCAL_SERVER || !isNotePath(path)) return;
    localDrafts[path] = {
        content,
        version: localDrafts[path]?.version ?? version ?? getServerFile(path)?.version ?? (getServerFile(path) ? 'unknown' : ''),
    };
    persistLocalDrafts();
}

function stageLocalDelete(path, version) {
    if (!window.FILES_MD_LOCAL_SERVER || !isNotePath(path)) return;
    localDrafts[path] = {deleted: true, version};
    persistLocalDrafts();
}

function localSyncNotice(message) {
    const notice = document.getElementById('connection-notice');
    notice.textContent = message;
    notice.hidden = !message;
}

function noteEditorContent(cm) {
    const value = cm.getValue();
    const prefix = toHeader(toFilename(cm.path)) + '\n';
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function editorsForNote(path) {
    return [window.editor, window.editor2].filter(cm => cm && cm.path === path && path !== CHAT_PATH);
}

function updateNoteEditor(cm, content, version) {
    const next = toHeader(toFilename(cm.path)) + '\n' + content;
    const old = cm.getValue();
    if (old !== next) {
        let start = 0, oldEnd = old.length, newEnd = next.length;
        while (start < Math.min(oldEnd, newEnd) && old[start] === next[start]) start++;
        while (oldEnd > start && newEnd > start && old[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
        const scroll = cm.getScrollInfo();
        cm.replaceRange(next.slice(start, newEnd), cm.posFromIndex(start), cm.posFromIndex(oldEnd), 'remote');
        cm.scrollTo(scroll.left, scroll.top);
    }
    cm.noteVersion = version;
    cm.markClean();
}

async function restoreLocalDrafts() {
    for (const [path, draft] of Object.entries(localDrafts)) {
        if (draft.deleted) {
            pendingFileDeletes.set(path, draft.version);
            continue;
        }
        await write(path, draft.content, {stageDraft: false});
        addMemFile(path, {isFile: true, path, handle: await getFileHandle(path)});
    }
}

async function syncLocalNotes(forcePath) {
    if (!hasLastServerOk()) return;
    while (isSyncingFiles) await new Promise(resolve => setTimeout(resolve, 25));
    if (isMessingWithCurrentEditor || isSaving || isLoadingLocalFiles) return;
    isSyncingFiles = true;
    try {
        if (!localNotesInitialized) await restoreLocalDrafts();
        let modified = [];
        if (localNotesInitialized) {
            // Refresh native handles too: an external editor may replace a file
            // atomically instead of modifying the inode behind the old handle.
            if (editor.isClean() && editor2.isClean()) files = await loadLocalFiles(await getRootDirHandle());
            ({modified} = await collectModifiedAndDeletedFiles());
        }
        if (forcePath && isNotePath(forcePath) && await exists(forcePath)) {
            const state = await getFileStatus(forcePath);
            if (state.status === 'error') throw new Error('Cannot read ' + forcePath);
            if (state.status === 'new' || state.status === 'modified') modified.push(state);
        }
        for (const note of modified) {
            if (isNotePath(note.path)) stageLocalDraft(note.path, note.content);
        }
        for (const [path, version] of pendingFileDeletes) stageLocalDelete(path, version);
        const writes = [], deletes = [];
        for (const [path, draft] of Object.entries(localDrafts)) {
            const change = {path: path.slice(1), version: String(draft.version || '')};
            if (draft.deleted) deletes.push(change);
            else writes.push({...change, content: draft.content});
        }
        const response = await fetch(`${API_URL}/notes/sync`, {
            method: 'POST', credentials: 'include',
            headers: {'Content-Type': 'application/json', 'X-FilesMD-Sync': '3'},
            body: JSON.stringify({writes, deletes}),
        });
        const body = await response.text();
        let snapshot;
        try { snapshot = JSON.parse(body); } catch {}
        if ((!response.ok && response.status !== 409) || !snapshot?.files || !Array.isArray(snapshot.directories)) {
            if (response.status === 401) localSyncNotice('Sign in again to reconnect to your notes. Your pending edits are kept in this browser.');
            throw new Error(`Sync failed (${response.status}): ${body}`);
        }
        const conflicts = snapshot.conflicts || {};
        const resolved = new Map();
        for (const sent of writes) {
            const path = '/' + sent.path;
            const copy = conflicts[sent.path];
            const saved = copy ? snapshot.files[copy] : snapshot.files[sent.path];
            if (saved?.content === sent.content && localDrafts[path]?.content === sent.content) {
                delete localDrafts[path];
                resolved.set(path, sent.content);
            }
        }
        // A conflict cancels the whole requested deletion batch. Restore the
        // disk copies and require a fresh, deliberate delete action.
        for (const sent of deletes) {
            const path = '/' + sent.path;
            if (String(pendingFileDeletes.get(path) || '') === sent.version) {
                pendingFileDeletes.delete(path);
                pendingFileMoves.delete(path);
                delete localDrafts[path];
            }
        }
        persistLocalDrafts();
        await applyNotesSnapshot(snapshot, resolved);
        server.initialized = true;
        localNotesInitialized = true;
        saveServerFiles();
        lastSyncOkAt = Date.now();
        renderSyncStatus(Object.keys(localDrafts).length ? 'edits' : 'ok');
        if (localSyncFailed) localSyncNotice('');
        localSyncFailed = false;
        if (Object.keys(conflicts).length) {
            const copies = Object.values(conflicts).filter(Boolean);
            localSyncNotice(copies.length
                ? 'A note changed on disk. Your edits were saved in Conflicts; both versions are kept.'
                : 'A note changed on disk. Its deletion was cancelled and the disk copy restored.');
            renderSidebar('/Conflicts');
        }
    } catch (error) {
        localSyncFailed = true;
        localSyncNotice('Sync is unavailable. Pending edits are kept in this browser; reconnect to save them to your notes folder.');
        renderSyncStatus('error');
        logError('Local notes sync:', error.message);
        throw error;
    } finally {
        isSyncingFiles = false;
    }
}

async function applyNotesSnapshot(snapshot, resolved) {
    const changed = [];
    for (const dir of snapshot.directories) {
        let handle = await getRootDirHandle();
        let entries = files;
        for (const part of dir.split('/')) {
            handle = await handle.getDirectoryHandle(part, {create: true});
            entries = entries[part + '/'] ||= {};
        }
    }
    for (const note of Object.values(snapshot.files)) {
        const path = '/' + note.path;
        const baseline = getServerFile(path);
        const local = await exists(path) ? await read(path) : undefined;
        const open = editorsForNote(path);
        const dirtyEditor = open.some(cm => !cm.isClean());
        const changedLocally = local !== undefined && local !== note.content &&
            (baseline ? hash(local) !== baseline.hash : local !== '') && resolved.get(path) !== local;
        if (dirtyEditor || changedLocally || localDrafts[path]) {
            if (changedLocally && !localDrafts[path]) stageLocalDraft(path, local, baseline?.version || 'unknown');
            continue;
        }
        {
            const lastClientModified = await writeIfContentIsDifferent(path, note.content, {stageDraft: false});
            addMemFile(path, {isFile: true, path, handle: await getFileHandle(path), lastModified: note.lastModified, lastClientModified});
            setServerFile(path, note.content, note.lastModified, lastClientModified);
            getServerFile(path).version = note.version;
            for (const cm of open) {
                if (!cm.isClean()) continue; // typing during the awaited file write
                updateNoteEditor(cm, note.content, note.version);
            }
            if (baseline?.version !== note.version) changed.push(path);
        }
    }
    const known = [];
    walk(server.files, (path, isFile) => { if (isFile && isNotePath(path)) known.push(path); });
    for (const path of known) {
        if (snapshot.files[path.slice(1)] || localDrafts[path]) continue;
        const baseline = getServerFile(path);
        const open = editorsForNote(path);
        if (open.some(cm => !cm.isClean())) continue;
        if (await exists(path)) {
            const content = await read(path);
            if (hash(content) !== baseline.hash && resolved.get(path) !== content) {
                stageLocalDraft(path, content, baseline.version || 'unknown');
                continue;
            }
            await remove(path, {syncDeletion: false});
        }
        removeServerFile(path);
        for (const cm of open) {
            cm.path = undefined;
            cm.setValue('');
            cm.markClean();
            if (cm === currentEditor) await openChat();
        }
        changed.push(path);
    }
    // Remove only directories previously mirrored from this server, and only
    // when empty. Unsent files must never be removed by recursive cleanup.
    for (const dir of (server.directories || []).filter(dir => !snapshot.directories.includes(dir)).sort((a, b) => b.length - a.length)) {
        const parts = dir.split('/');
        const name = parts.pop();
        try {
            let parent = await getRootDirHandle();
            for (const part of parts) parent = await parent.getDirectoryHandle(part);
            await parent.removeEntry(name);
            removeMemDir('/' + dir + '/');
        } catch (error) {
            if (error.name !== 'NotFoundError' && error.name !== 'InvalidModificationError') throw error;
        }
    }
    server.directories = snapshot.directories;
    await renderSidebar('', changed);
    if (isChat && (changed.includes(CHAT_PATH) || !snapshot.files['Chat.md'])) await renderMessages();
}

function startLocalNotesSync() {
    if (!window.FILES_MD_LOCAL_SERVER || localSyncTimer) return;
    localSyncTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && !isSyncingFiles) {
            syncLocalNotes().catch(() => {});
        }
    }, 2000);
}

window.addEventListener('beforeunload', () => {
    clearInterval(localSyncTimer);
    if (!window.FILES_MD_LOCAL_SERVER) return;
    for (const cm of [window.editor, window.editor2]) {
        if (cm?.path && cm.path !== CHAT_PATH && !cm.isClean()) stageLocalDraft(cm.path, noteEditorContent(cm), cm.noteVersion);
    }
});
