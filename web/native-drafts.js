// Native folders use their own draft journal. It never shares paths or writes
// with the server workspace, and each tab owns independent recovery records.
const NATIVE_DRAFT_PREFIX = 'native-note-drafts-v1:';

function nativeDraftPrefix() {
    const workspace = selectedDiskWorkspaceID();
    return workspace ? NATIVE_DRAFT_PREFIX + workspace + ':' : null;
}

function nativeDraftEntries(path) {
    const prefix = nativeDraftPrefix();
    if (!prefix) return [];
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const value = localStorage.getItem(key);
        try {
            const draft = JSON.parse(value);
            if (draft.path === path && typeof draft.content === 'string') entries.push({key, value, draft});
        } catch {
            // Keep unreadable records for recovery rather than discarding them.
        }
    }
    return entries.sort((a, b) =>
        Number(b.draft.tab === localMirrorID) - Number(a.draft.tab === localMirrorID) ||
        (b.draft.updatedAt || 0) - (a.draft.updatedAt || 0));
}

function stageNativeDraft(cm) {
    const prefix = nativeDraftPrefix();
    if (!prefix || !canModifyWorkspace() || !cm?.path) return;
    const draft = {
        path: cm.path,
        content: noteEditorContent(cm),
        editorTitle: cm.getLine(0),
        baseContent: cm.nativeBaselineContent,
        tab: localMirrorID,
        updatedAt: Date.now(),
    };
    try {
        localStorage.setItem(prefix + localMirrorID + ':' + encodeURIComponent(cm.path), JSON.stringify(draft));
    } catch (error) {
        localSyncNotice('Browser recovery storage is unavailable. Keep this tab open until the note is saved to its folder.');
        throw error;
    }
}

function retireNativeDraft(entry) {
    if (localStorage.getItem(entry.key) === entry.value) localStorage.removeItem(entry.key);
}

async function recoverNativeDraft(path, diskContent) {
    if (!nativeDraftPrefix()) return null;
    const candidates = [];
    const recoveredPaths = [];
    for (const entry of nativeDraftEntries(path)) {
        const draft = entry.draft;
        const pendingTitle = draft.editorTitle && draft.editorTitle !== toHeader(toFilename(path));
        if (draft.content === diskContent && !pendingTitle) {
            retireNativeDraft(entry);
            continue;
        }
        if (draft.baseContent !== diskContent && draft.content !== diskContent) {
            requireWritableWorkspace();
            // A random suffix and existence check prevent recovery from replacing
            // any existing note, including another tab's simultaneous recovery.
            let recoveredPath;
            do {
                const suffix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
                recoveredPath = '/Conflicts/Recovered ' + suffix + ' ' + toFilename(path);
            } while (await exists(recoveredPath));
            const recoveredContent = pendingTitle ? draft.editorTitle + '\n' + draft.content : draft.content;
            await write(recoveredPath, recoveredContent, {stageDraft: false});
            addMemFile(recoveredPath, {
                isFile: true, path: recoveredPath,
                handle: await getFileHandle(recoveredPath),
            });
            recoveredPaths.push(recoveredPath);
            retireNativeDraft(entry);
            localSyncNotice('The note also changed on disk. Your unsaved edit is preserved in ' + recoveredPath.slice(1));
            continue;
        }
        candidates.push(draft);
    }
    if (recoveredPaths.length) await renderSidebar('', recoveredPaths);
    return candidates[0] || null;
}

function acknowledgeNativeDraft(path, content, editorTitle = toHeader(toFilename(path))) {
    for (const entry of nativeDraftEntries(path)) {
        if (entry.draft.content === content && entry.draft.editorTitle === editorTitle) retireNativeDraft(entry);
    }
}

window.addEventListener('beforeunload', () => {
    for (const cm of [window.editor, window.editor2]) {
        if (cm?.path && !cm.isClean()) {
            try { stageNativeDraft(cm); } catch {}
        }
    }
});
