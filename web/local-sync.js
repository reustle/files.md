// Local-server sync uses complete directory snapshots and SHA-256 versions.
// Browser absence never asks the server to delete a file. Only remove() does.
const LOCAL_DRAFT_KEY = 'notes-drafts-v3:' + API_URL;
const LOCAL_JOURNAL_PREFIX = LOCAL_DRAFT_KEY + ':entry:';
const localMirrorID = (() => {
    const key = 'notes-mirror-tab:' + API_URL;
    const fresh = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    try {
        // Reload preserves cached notes for offline reading. A duplicated tab
        // navigates independently and receives a separate browser mirror.
        const reloading = performance.getEntriesByType('navigation')[0]?.type === 'reload';
        const id = reloading && sessionStorage.getItem(key) || fresh;
        sessionStorage.setItem(key, id);
        return id;
    } catch { return fresh; }
})();
const persistedDraftEntries = new Map();
let localDraftStorageFailed = false;
let malformedLegacyDrafts = false;
let localDrafts = readLocalDrafts();

function readLocalDrafts() {
    const drafts = {};
    // Each pending edit has its own record. A second tab cannot overwrite an
    // entire shared draft map and silently erase the first tab's offline work.
    const entries = [];
    const legacy = localStorage.getItem(LOCAL_DRAFT_KEY);
    if (legacy) {
        try { entries.push(...Object.entries(JSON.parse(legacy))); } catch {
            localDraftStorageFailed = true; // Retain malformed data for recovery.
            malformedLegacyDrafts = true;
        }
    }
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key.startsWith(LOCAL_JOURNAL_PREFIX)) continue;
        try {
            const record = JSON.parse(localStorage.getItem(key));
            if (typeof record.path !== 'string' || !record.draft ||
                (!record.draft.deleted && typeof record.draft.content !== 'string')) throw new Error('Invalid draft');
            entries.push([record.path, {...record.draft, journalID: key}]);
            persistedDraftEntries.set(key, localStorage.getItem(key));
        } catch { localDraftStorageFailed = true; }
    }
    for (let [path, draft] of entries) {
        const previous = drafts[path];
        if (previous && (previous.content !== draft.content || previous.deleted !== draft.deleted || previous.editorTitle !== draft.editorTitle)) {
            // Conflicting unsent work from separate tabs is never discarded.
            // A deletion is cancelled when another tab has an unsaved edit.
            if (draft.deleted) continue;
            if (!previous.deleted) {
                path = '/Conflicts/Recovered ' + localMirrorID + '-' + Object.keys(drafts).length + ' ' + toFilename(path);
                draft = {...draft, version: ''};
            }
        }
        drafts[path] = draft;
    }
    return drafts;
}
const LOCAL_DIRECTORY_KEY = 'notes-directories-v3:' + API_URL;
let localDirectoryChanges = JSON.parse(localStorage.getItem(LOCAL_DIRECTORY_KEY) || '{}');
let localNotesInitialized = false;
let localSyncTimer = null;
let localSyncFailed = false;
const localBaselineContents = new Map();

function isNotePath(path) { return /\.md$/i.test(path); }

async function matchesLocalBaseline(path, content, baseline = getServerFile(path)) {
    if (!baseline?.version) return false;
    const known = localBaselineContents.get(path);
    if (known?.version === baseline.version) return known.content === content;
    // A fresh browser can compare its persisted content version. If the
    // environment cannot verify it, preserve the local copy conservatively.
    if (!globalThis.crypto?.subtle) return false;
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const version = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return version === baseline.version;
}

function persistLocalDrafts() {
    const retained = new Set();
    const wasStorageFailure = localDraftStorageFailed;
    try {
        // Write all replacements before removing any older recovery records.
        for (const [path, draft] of Object.entries(localDrafts)) {
            draft.journalID ||= LOCAL_JOURNAL_PREFIX + localMirrorID + ':' + Math.random().toString(36).slice(2);
            let value = JSON.stringify({path, draft});
            const previous = persistedDraftEntries.get(draft.journalID);
            if (previous !== undefined && previous !== value) {
                // Recovery may have adopted an active tab's record. Any edit,
                // conflict remapping, or acknowledged-version update writes a
                // new key; retirement below uses the original value as a CAS.
                draft.journalID = LOCAL_JOURNAL_PREFIX + localMirrorID + ':' + Math.random().toString(36).slice(2);
                value = JSON.stringify({path, draft});
            }
            if (previous !== value) localStorage.setItem(draft.journalID, value);
            persistedDraftEntries.set(draft.journalID, value);
            retained.add(draft.journalID);
        }
        for (const [key, value] of persistedDraftEntries) {
            if (retained.has(key)) continue;
            if (localStorage.getItem(key) === value) localStorage.removeItem(key);
            persistedDraftEntries.delete(key);
        }
        if (!malformedLegacyDrafts) localStorage.removeItem(LOCAL_DRAFT_KEY);
        localDraftStorageFailed = false;
        if (wasStorageFailure && !localSyncFailed) localSyncNotice('');
    } catch (error) {
        localDraftStorageFailed = true;
        localSyncNotice('Browser storage is full or unavailable. Keep this tab open until your edits are synced, or copy them somewhere safe.');
        renderSyncStatus('error');
        throw error;
    }
}

function stageLocalDraft(path, content, version, editorTitle = localDrafts[path]?.editorTitle) {
    if (!window.FILES_MD_LOCAL_SERVER || !isNotePath(path)) return;
    localDrafts[path] = {
        content,
        ...(editorTitle && editorTitle !== toHeader(toFilename(path)) ? {editorTitle} : {}),
        version: localDrafts[path]?.version ?? version ?? getServerFile(path)?.version ?? (getServerFile(path) ? 'unknown' : ''),
    };
    persistLocalDrafts();
}

function stageLocalDelete(path, version) {
    if (!window.FILES_MD_LOCAL_SERVER || !isNotePath(path)) return;
    localDrafts[path] = {deleted: true, version};
    persistLocalDrafts();
}

function stageLocalDirectory(path, action) {
    if (!window.FILES_MD_LOCAL_SERVER) return;
    path = '/' + path.split('/').filter(Boolean).join('/');
    if (path === '/') return;
    localDirectoryChanges[path] = {action, id: Date.now() + ':' + Math.random()};
    persistLocalDirectories();
}

function persistLocalDirectories() {
    localStorage.setItem(LOCAL_DIRECTORY_KEY, JSON.stringify(localDirectoryChanges));
}

function localSyncNotice(message) {
    const notice = document.getElementById('connection-notice');
    notice.textContent = message;
    notice.hidden = !message;
}

function noteEditorContent(cm) {
    const value = cm.getValue();
    // The editable title is metadata, including while a rename is pending.
    const newline = value.indexOf('\n');
    return value.startsWith('# ') ? (newline < 0 ? '' : value.slice(newline + 1)) : value;
}

function editorsForNote(path) {
    return [window.editor, window.editor2].filter(cm => cm && cm.path === path);
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
    for (const [path, change] of Object.entries(localDirectoryChanges)) {
        if (change.action === 'mkdir') await createDir(path, {syncDirectory: false});
    }
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
    while (isSyncingFiles || isMessingWithCurrentEditor || isSaving || isLoadingLocalFiles) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
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
            if (isNotePath(note.path) && !localDrafts[note.path]) stageLocalDraft(note.path, note.content);
        }
        for (const [path, version] of pendingFileDeletes) stageLocalDelete(path, version);
        const directoryChanges = Object.entries(localDirectoryChanges);
        const mkdirs = directoryChanges.filter(([, change]) => change.action === 'mkdir').map(([path]) => path.slice(1));
        const rmdirs = directoryChanges.filter(([, change]) => change.action === 'rmdir').map(([path]) => path.slice(1));
        const writes = [], deletes = [];
        for (const [path, draft] of Object.entries(localDrafts)) {
            const change = {path: path.slice(1), version: String(draft.version || '')};
            if (draft.deleted) deletes.push(change);
            else writes.push({...change, content: draft.content});
        }
        const response = await fetch(`${API_URL}/notes/sync`, {
            method: 'POST', credentials: 'include',
            headers: {'Content-Type': 'application/json', 'X-FilesMD-Sync': '3'},
            body: JSON.stringify({writes, deletes, mkdirs, rmdirs}),
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
            if (saved?.content === sent.content && !copy && localDrafts[path] && !localDrafts[path].deleted) {
                // A newer keystroke made during this request is based on the
                // version we just saved, not the older request baseline.
                localDrafts[path].version = saved.version;
                let baseline = getServerFile(path);
                if (!baseline) {
                    setServerFile(path, sent.content, saved.lastModified);
                    baseline = getServerFile(path);
                    baseline.version = sent.version;
                }
                if (baseline.version === sent.version) {
                    baseline.version = saved.version;
                    localBaselineContents.set(path, {content: sent.content, version: saved.version});
                }
                for (const cm of editorsForNote(path)) {
                    if (String(cm.noteVersion || '') === sent.version) cm.noteVersion = saved.version;
                }
            }
            if (saved?.content === sent.content && !localDrafts[path]?.editorTitle && !localDrafts[path]?.deleted && localDrafts[path]?.content === sent.content) {
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
                if (localDrafts[path]?.deleted && String(localDrafts[path].version || '') === sent.version) {
                    delete localDrafts[path];
                } else if (localDrafts[path] && !snapshot.files[sent.path]) {
                    // The user recreated the note while its deletion request
                    // was in flight. Save that new draft against absence.
                    localDrafts[path].version = '';
                }
            }
        }
        persistLocalDrafts();
        for (const [path, sent] of directoryChanges) {
            if (localDirectoryChanges[path]?.id !== sent.id) continue;
            if (sent.action === 'rmdir' || snapshot.directories.includes(path.slice(1))) delete localDirectoryChanges[path];
        }
        persistLocalDirectories();
        await applyNotesSnapshot(snapshot, resolved);
        server.initialized = true;
        localNotesInitialized = true;
        saveServerFiles();
        lastSyncOkAt = Date.now();
        renderSyncStatus(Object.keys(localDrafts).length || Object.keys(localDirectoryChanges).length ||
            [window.editor, window.editor2].some(cm => cm?.path && !cm.isClean()) ? 'edits' : 'ok');
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
        if (!localDraftStorageFailed) localSyncNotice('Sync is unavailable. Pending edits are kept in this browser; reconnect to save them to your notes folder.');
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
        if (localDirectoryChanges['/' + dir]?.action === 'rmdir') continue;
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
            (baseline ? !await matchesLocalBaseline(path, local, baseline) : local !== '') && resolved.get(path) !== local;
        if (dirtyEditor || changedLocally || localDrafts[path]) {
            if (changedLocally && !localDrafts[path]) stageLocalDraft(path, local, baseline?.version || 'unknown');
            continue;
        }
        {
            const lastClientModified = await writeIfContentIsDifferent(path, note.content, {stageDraft: false});
            addMemFile(path, {isFile: true, path, handle: await getFileHandle(path), lastModified: note.lastModified, lastClientModified});
            setServerFile(path, note.content, note.lastModified, lastClientModified);
            getServerFile(path).version = note.version;
            localBaselineContents.set(path, {content: note.content, version: note.version});
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
            if (!await matchesLocalBaseline(path, content, baseline) && resolved.get(path) !== content) {
                stageLocalDraft(path, content, baseline.version || 'unknown');
                continue;
            }
            await remove(path, {syncDeletion: false});
        }
        removeServerFile(path);
        localBaselineContents.delete(path);
        for (const cm of open) {
            cm.path = undefined;
            cm.setValue('');
            cm.markClean();
            cm.setOption('readOnly', true);
            if (cm === window.editor2) hideEditor2();
        }
        changed.push(path);
    }
    // Remove only directories previously mirrored from this server, and only
    // when empty. Unsent files must never be removed by recursive cleanup.
    for (const dir of (server.directories || []).filter(dir => !snapshot.directories.includes(dir)).sort((a, b) => b.length - a.length)) {
        if (localDirectoryChanges['/' + dir]?.action === 'mkdir') continue;
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
    if (!window.editor?.path) {
        document.getElementById('notes-empty').hidden = false;
        document.getElementById('editor-container').style.display = 'none';
    }
}

function startLocalNotesSync() {
    if (!window.FILES_MD_LOCAL_SERVER || localSyncTimer) return;
    watchLocalNotes().catch(() => {});
    localSyncTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && !isSyncingFiles) {
            syncLocalNotes().catch(() => {});
        }
    }, 2000);
}

let localWatchController;
let localWatchConnected = false;
async function watchLocalNotes() {
    while (true) {
        localWatchController = new AbortController();
        try {
            const response = await fetch(`${API_URL}/notes/events`, {
                credentials: 'include', headers: {'X-FilesMD-Sync': '3'},
                cache: 'no-store', signal: localWatchController.signal,
            });
            if (!response.ok || !response.body) throw new Error('Watcher unavailable');
            localWatchConnected = true;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            try {
                while (true) {
                    const {value, done} = await reader.read();
                    if (done) break;
                    pending = (pending + decoder.decode(value, {stream: true})).replace(/\r\n/g, '\n');
                    let end;
                    while ((end = pending.indexOf('\n\n')) !== -1) {
                        const event = pending.slice(0, end);
                        pending = pending.slice(end + 2);
                        if (/^event: ?change$/m.test(event) && !isSyncingFiles) syncLocalNotes().catch(() => {});
                    }
                }
            } finally { reader.releaseLock(); }
        } catch { /* polling remains available during reconnect */ }
        finally { localWatchConnected = false; }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

window.addEventListener('beforeunload', event => {
    if (!window.FILES_MD_LOCAL_SERVER) return;
    for (const cm of [window.editor, window.editor2]) {
        if (cm?.path && !cm.isClean()) {
            try { stageLocalDraft(cm.path, noteEditorContent(cm), cm.noteVersion, cm.getLine(0)); } catch {}
        }
    }
    if (localDraftStorageFailed) {
        event.preventDefault();
        event.returnValue = '';
    }
});
