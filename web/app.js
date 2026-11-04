const sidebar = document.getElementById('sidebar');
const content = document.getElementById('content')

const LATER_PATH = '/Later.md';
const READ_PATH = '/Read.md';
const SHOP_PATH = '/Shop.md';
const WATCH_PATH = '/Watch.md';
const LOG_PATH = '/archive/Log.md';
let isMemFS = false;
let debug = false;
// let debug = {dir: '', file: 'File.md', loaded: false};

function updateWorkspaceLabel(name) {
    const label = document.getElementById('workspace-path');
    const text = typeof name === 'string' && name.trim() ? name : 'Notes';
    label.textContent = text;
    label.title = text;
}

function refreshWorkspaceControls() {
    const writable = canModifyWorkspace();
    for (const id of ['new-file', 'new-folder', 'create-first-note']) {
        const button = document.getElementById(id);
        if (button) button.disabled = !writable;
    }
    for (const cm of [window.editor, window.editor2]) {
        if (cm) cm.setOption('readOnly', !writable || !cm.path);
    }
    const message = document.getElementById('notes-empty-message');
    if (message) message.textContent = writable
        ? 'Choose a note from the sidebar, or create your first note.'
        : 'Connect to a folder on disk before creating or editing notes.';
}

function allowWorkspaceAction() {
    if (canModifyWorkspace()) return true;
    showToast('Connect to a folder on disk before creating or editing notes');
    return false;
}

async function init() {
    setWorkspaceConnection(null);
    updateWorkspaceLabel('No folder connected');
    // Ask the browser to mark our origin as persistent so the quota
    // manager can't evict the auth cookie + localStorage under disk
    // pressure. Chrome auto-grants for installed PWAs / high-engagement
    // sites; otherwise resolves false and we run on best-effort storage.
    // Idempotent - safe to call on every load.
    if (navigator.storage && navigator.storage.persist) {
        // Firefox may wait for a permission decision; it must not block login.
        navigator.storage.persist()
            .then(persisted => log('Storage persisted:', persisted))
            .catch(error => logError('Storage persistence request failed:', error.message));
    }

    // Authorize if we have one-time token in URL.
    const urlParams = new URLSearchParams(window.location.search);
    const oneTimeToken = urlParams.get('token');
    if (oneTimeToken) {
        try {
            // Exchange one-time token for permanent token
            const response = await fetch(`${API_URL}/issuePermanentToken`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'X-FilesMD-Sync': SYNC_PROTOCOL_VERSION,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    oneTimeToken: oneTimeToken
                })
            });

            if (response.ok) {
                // Server sets the auth cookie via Set-Cookie on this response.
                markServerOk();
                const url = new URL(window.location);
                url.searchParams.delete('token');
                window.history.replaceState({}, '', url);
            } else {
                alert('The token has expired or is invalid. Please try to request a new link.');
                logError('Token exchange failed:', response.status);
            }
        } catch (error) {
            alert('The token has expired or is invalid. Please try to request a new link.');
            logError('Error exchanging token:', error);
        }
    }

    if (window.FILES_MD_LOCAL_SERVER) {
        // Cookies survive a port change, but localStorage does not. Discover
        // the real session instead of silently skipping the initial download.
        const notice = document.getElementById('connection-notice');
        try {
            const response = await fetch(`${API_URL}/session`, {
                credentials: 'include',
                cache: 'no-store',
            });
            if (!response.ok) throw new Error(`Session check failed: ${response.status}`);
            const session = await response.json();
            if (session.authenticated) {
                updateWorkspaceLabel(session.workspacePath);
                markServerOk();
                notice.hidden = true;
            } else {
                localStorage.removeItem(LAST_SERVER_OK_KEY);
                notice.textContent = 'This browser is not connected to your notes folder. Open the server access link to connect. Creating and editing notes is disabled until connected.';
                notice.hidden = false;
            }
        } catch (error) {
            notice.textContent = 'Cannot connect to your notes folder. Cached notes are read-only until the connection is verified.';
            notice.hidden = false;
            logError('Session check failed:', error.message);
        }
    }

    const savedDirHandle = await getSavedRootDirHandle();
    const hasSavedLocalDir = typeof FileSystemDirectoryHandle !== 'undefined' && savedDirHandle instanceof FileSystemDirectoryHandle;
    document.getElementById('open-folder-btn').style.display =
        typeof window.showDirectoryPicker === 'function' ? 'inline-flex' : 'none';
    isMemFS = !hasSavedLocalDir;
    if (hasSavedLocalDir) updateWorkspaceLabel(savedDirHandle.name);

    // Let's create local-first like experience by preloading images.
    if (isMemFS) {
        prefetchWelcomeImages();
    }

    let perf = performance.now();
    try {
        if (hasSavedLocalDir && typeof savedDirHandle.queryPermission === 'function' &&
            await savedDirHandle.queryPermission({mode: 'readwrite'}) !== 'granted') {
            throw new Error('Folder permission needs to be granted again');
        }
        files = await loadLocalFiles(await getRootDirHandle());
        if (hasSavedLocalDir) {
            setWorkspaceConnection('local');
            document.getElementById('connection-notice').hidden = true;
        }
    } catch (error) {
        files = {};
        const notice = document.getElementById('connection-notice');
        notice.textContent = 'Cannot access the selected folder. Reopen it with the folder button to restore access. Editing is disabled.';
        notice.hidden = false;
        logError('Workspace unavailable:', error.message);
    }
    log(`Files loaded in ${performance.now() - perf}ms`);

    perf = performance.now();
    renderSidebar();
    log(`Sidebar built in: ${(performance.now() - perf).toFixed(3)} milliseconds`);

    perf = performance.now();
    await syncFilesWithServer().catch(error => logError('Initial sync:', error.message));
    await renderSidebar();
    await syncMediaFiles();
    log(`Files initialized in: ${(performance.now() - perf).toFixed(3)} milliseconds`);
    await openNotesHome({saveCurrent: false});
    startLocalNotesSync();

}

// A workspace starts with an existing note or an empty, non-writing view.
// Opening the app must never create a note on the user's behalf.
async function openNotesHome({saveCurrent = true} = {}) {
    while (isMessingWithCurrentEditor || isSyncingFiles || isSaving) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (saveCurrent && currentEditor?.path && !currentEditor.isClean()) {
        await syncCurrentFile(true);
        // Failed writes and invalid pending renames leave the buffer dirty.
        // Keep it visible instead of replacing it with the home view.
        if (!currentEditor.isClean()) return;
    }
    const paths = [];
    walk(files, (path, isFile) => {
        if (isFile && /\.md$/i.test(path)) paths.push(path);
    });
    paths.sort((a, b) => a.localeCompare(b));
    let remembered;
    try { remembered = sessionStorage.getItem(workspaceNoteKey()); } catch {}
    if (!remembered && history.state?.workspaceKey === workspaceNoteKey()) remembered = history.state.path;
    const next = paths.includes(remembered) ? remembered
        : paths.includes('/🪴 Welcome.md') ? '/🪴 Welcome.md' : paths[0];
    if (next) {
        await openFile(next, false);
        return;
    }
    isMessingWithCurrentEditor = true;
    try {
        currentEditor = editor;
        editor.path = undefined;
        editor.noteVersion = undefined;
        editor.setValue('');
        editor.markClean();
        editor.setOption('readOnly', true);
        hideEditor2();
        document.getElementById('editor-container').style.display = 'none';
        document.getElementById('notes-empty').hidden = false;
        renderSidebar();
    } finally {
        isMessingWithCurrentEditor = false;
    }
}

// Logic for click-handling is in click.js => isWikiLink
function createAutocompleteDict() {
    const entries = [];
    const currentPath = currentEditor && currentEditor.path;

    // Collect all files with their metadata
    walkFilesExcludingSystemDirs((path) => {
        if (path === CONFIG_PATH || path === LATER_PATH || path === READ_PATH || path === WATCH_PATH || path === SHOP_PATH) {
            return;
        }
        if (path === currentPath) {
            return;
        }

        const filename = toFilename(path);
        const key = `${filename.replace(/\.md$/, '')}`;
        const url = encodeLinkPath(path);
        const filePath = `${filename.replace(/\.md$/, '')}](${url})`;

        entries.push({
            key,
            filePath,
            lastModified: getMemFile(path).lastModified
        });

    });

    // Sort by last modified (most recent first)
    entries.sort((a, b) => b.lastModified - a.lastModified);
    const dict = {};
    entries.forEach(entry => {
        dict[entry.key] = entry.filePath;
    });

    let lowPriorityEntries = [];
    ['_read_/', '_watch_/', '_shop_/', 'today/', 'later/', 'journal/'].forEach(dir => {
        if (!files[dir]) {
            return;
        }

        Object.keys(files[dir]).forEach(filename => {
            if (filename === CONFIG_PATH) {
                return;
            }
            const key = `${filename.replace(/\.md$/, '')}`;
            const url = encodeLinkPath(`${dir}/${filename}`);
            const filePath = `${filename.replace(/\.md$/, '')}](${url})`;

            lowPriorityEntries.push({
                key,
                filePath,
                lastModified: files[dir][filename].lastModified
            });
        });
    });

    lowPriorityEntries.sort((a, b) => b.lastModified - a.lastModified);
    lowPriorityEntries.forEach(entry => {
        dict[entry.key] = entry.filePath;
    });

    return dict;
}

// Called when the link autocomplete inserts a completion. For a classic
// `[name](/path.md)` file link, add a backlink in the target pointing back to
// the file we inserted from. Ignores wiki/emoji completions (no `](`).
function onLinkPicked(completionText) {
    const text = completionText || '';
    const open = text.lastIndexOf('](');
    if (open === -1 || text.slice(-1) !== ')') return;
    const url = text.slice(open + 2, -1);
    const targetPath = url.replace(/%20/g, ' ').replace(/%28/g, '(').replace(/%29/g, ')');
    addBacklink(currentEditor.path, targetPath);
}

async function newFile(parentDir) {
    if (!allowWorkspaceAction()) return;
    log('New file clicked');
    // New files always land at the root. The `parentDir` parameter is still
    // honored (sidebar right-click → New file inside a specific folder).
    const dirPath = parentDir !== undefined
        ? (parentDir === '/' ? '/' : parentDir.replace(/\/$/, ''))
        : '/';

    let filename = 'New file.md';
    let num = 1;
    while (getMemFile(joinPath(dirPath, filename)) !== null) {
        log('file exists', joinPath(dirPath, filename));
        filename = `New file (${num}).md`;
        num++;
    }

    const path = joinPath(dirPath, filename);
    log('PATH', path);
    let handle = await getFileHandle(path, true);
    addMemFile(path, {
        isFile: true,
        content: '',
        lastModified: 0,
        handle: handle,
        path: path,
        imageUrl: null
    });

    log('Creating new file', path);
    await openFile(path);
    log('CURRENT path after new', currentEditor.path);
    editor.setCursor({ line: 1, ch: 0 });
    editor.focus();

    await renderSidebar();
}

async function newFolder() {
    if (!allowWorkspaceAction()) return;
    let folderName = prompt('Enter folder name:', 'New Folder');
    if (folderName === null) {
        return;
    }

    folderName = folderName.trim();
    if (!folderName) {
        alert('Folder name cannot be empty');
        return;
    }
    if (!allowWorkspaceAction()) return;

    let finalFolderName = folderName;
    let num = 1;
    while (files[finalFolderName + '/']) {
        finalFolderName = `${folderName} (${num})`;
        num++;
    }

    const rootDirHandle = await getRootDirHandle();
    await rootDirHandle.getDirectoryHandle(finalFolderName, { create: true });
    files[finalFolderName + '/'] = {};

    log('CREATED folder', finalFolderName);

    await renderSidebar(finalFolderName);
}

function isMetaKey(event) {
    return event.metaKey || event.ctrlKey;
}

function isSidebarToggleShortcut(event) {
    if (!isMetaKey(event)) {
        return false;
    }

    // Match the physical shortcut key across ANSI/ISO keyboard layouts.
    return event.code === 'Backquote'
        || event.code === 'IntlBackslash'
        || event.key === '`'
        || event.key === '~'
        || event.key === '§'
        || event.key === '±';
}

async function openDir() {
    let dirHandle = null;
    try {
        dirHandle = await window.showDirectoryPicker({ 'mode': 'readwrite' });
    } catch (error) {
        // User pressed Esc (AbortError) or the browser doesn't support
        // the picker (TypeError).
        if (error instanceof TypeError) {
            alert('For now only Chrome browser supports local folders :(');
        }
        return;
    }
    try {
        if (typeof dirHandle.queryPermission === 'function' &&
            await dirHandle.queryPermission({mode: 'readwrite'}) !== 'granted') {
            showToast('Read and write access is required to connect this folder');
            return;
        }
    } catch (error) {
        showToast('Could not verify access to the selected folder');
        return;
    }

    // Flush the old workspace before changing its directory handle. Otherwise
    // opening the first note in the new folder could save the old buffer there.
    const previousEditor = currentEditor;
    for (const cm of [window.editor, window.editor2]) {
        if (!cm?.path || cm.isClean()) continue;
        currentEditor = cm;
        await syncCurrentFile(true);
        if (!cm.isClean()) {
            currentEditor = previousEditor;
            showToast('Save the pending note before opening another folder');
            return;
        }
    }
    currentEditor = previousEditor;

    while (isLoadingLocalFiles || isSyncingFiles || isMessingWithCurrentEditor || isSaving) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    isSyncingFiles = true;
    const previousConnection = getWorkspaceConnection();
    setWorkspaceConnection(null);
    try {
        // Opening a folder never copies another workspace's notes into it.
        // Read it successfully before committing this tab's new selection.
        const selectedFiles = await loadLocalFiles(dirHandle);
        await saveDirectoryHandle(dirHandle);
        localWatchController?.abort();
        clearInterval(localSyncTimer);
        localSyncTimer = null;
        for (const cm of [window.editor, window.editor2]) {
            if (!cm) continue;
            cm.path = undefined;
            cm.noteVersion = undefined;
        }
        files = selectedFiles;
        pendingFileDeletes.clear();
        pendingFileMoves.clear();
        setWorkspaceConnection('local');
    } catch (error) {
        setWorkspaceConnection(previousConnection);
        showToast('Could not open the selected folder: ' + error.message);
        return;
    } finally {
        isSyncingFiles = false;
    }

    isMemFS = false;
    updateWorkspaceLabel(dirHandle.name);
    document.getElementById('connection-notice').hidden = true;
    renderSidebar();
    await openNotesHome({saveCurrent: false});
}

function getCurrentContent() {
    let content = currentEditor.getValue();
    const header = toHeader(toFilename(currentEditor.path)).toLowerCase();
    // Remove header if it exists.
    if (content.toLowerCase().startsWith(header)) {
        content = content.slice(`${header}\n`.length);
    } else if (content.toLowerCase().startsWith('# ')) {
        // Skip header placeholder.
        // What is the case when starts with # '? Empty filename? Header not equal to original header?
        // TODO but do we always have \n?
        content = content.slice(`# \n`.length);
    }

    return content;
}

function toHeader(filename) {
    let header = filename;
    if (filename.endsWith('.md')) {
        header = trimPostfix(filename, '.md');
    }

    return `# ${header}`;
}

function fromHeaderToFilename(header) {
    if (header.startsWith('# ')) {
        return header.slice(2).trim() + '.md';
    }
    return header.trim() + '.md';
}

function ucfirst(val) {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

async function getImageUrl(fileHandle) {
    const file = await fileHandle.getFile();
    return URL.createObjectURL(file);
}

// Normalize text to use only \n as line endings
function normNewLines(text) {
    return text.replace(/\r\n|\r/g, '\n');
}

function showToast(msg, ms = 1500) {
    const toast = document.createElement('div');
    if (msg instanceof Node) {
        toast.appendChild(msg);
    } else {
        toast.textContent = msg;
    }
    // Center over the editor area (not the whole viewport) so the toast
    // sits above the content rather than drifting onto the sidebar.
    const editorContainer = document.getElementById('editor-container');
    const rect = editorContainer ? editorContainer.getBoundingClientRect() : null;
    const centerX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    toast.style.cssText = `
        position: fixed; top: 8px; left: ${centerX}px; transform: translateX(-50%);
        background: var(--col-bg-alt); color: var(--col-tx); padding: 8px 16px; border-radius: 5px;
        border: 1px solid var(--col-border);
        z-index: 9999; font-size: 14px;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), ms);
}

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('files', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('handles')) {
                db.createObjectStore('handles');
            }
        };
    });
}

// Folder choices belong to a tab. Immutable handle records let duplicated and
// restored tabs keep their original folder even when another tab changes its own.
const TAB_DIRECTORY_KEY = 'files-directory-selection:' + API_URL;
let selectedDirectoryHandle;
let selectedDirectoryID = null;
let selectedDirectoryLoad;

function hasSelectedDiskFolder() { return !!selectedDirectoryHandle; }
function selectedDiskWorkspaceID() { return selectedDirectoryID; }

async function handleStoreRequest(mode, action) {
    const db = await initDB();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('handles', mode);
            const request = action(tx.objectStore('handles'));
            let result;
            request.onsuccess = () => { result = request.result; };
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
        });
    } finally { db.close(); }
}

async function saveDirectoryHandle(directoryHandle) {
    let id;
    const keys = await handleStoreRequest('readonly', store => store.getAllKeys());
    for (const key of keys) {
        if (typeof key !== 'string' || !key.startsWith('directory:')) continue;
        const saved = await handleStoreRequest('readonly', store => store.get(key));
        try {
            if (saved && await directoryHandle.isSameEntry(saved)) { id = key; break; }
        } catch { /* An inaccessible old folder must not prevent opening another. */ }
    }
    id ||= 'directory:' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    await handleStoreRequest('readwrite', store => {
        store.put(directoryHandle, id);
        return store.put(id, 'defaultDirectorySelection');
    });
    // Update this tab only after the transaction has durably committed.
    sessionStorage.setItem(TAB_DIRECTORY_KEY, id);
    selectedDirectoryID = id;
    selectedDirectoryHandle = directoryHandle;
    selectedDirectoryLoad = null;
}

async function getSavedRootDirHandle() {
    if (selectedDirectoryHandle !== undefined) return selectedDirectoryHandle;
    if (selectedDirectoryLoad) return selectedDirectoryLoad;
    selectedDirectoryLoad = (async () => {
        let id = sessionStorage.getItem(TAB_DIRECTORY_KEY);
        if (id === null) {
            id = await handleStoreRequest('readonly', store => store.get('defaultDirectorySelection'));
            // Migrate the old global handle without deleting it. New selections
            // never mutate it, so an existing tab cannot be redirected later.
            if (!id) {
                const legacy = await handleStoreRequest('readonly', store => store.get('savedDirectoryHandle'));
                if (legacy) {
                    await saveDirectoryHandle(legacy);
                    return selectedDirectoryHandle;
                }
            }
            // Pin server/no-folder tabs too. Otherwise every save could adopt a
            // different tab's newly chosen default folder.
            sessionStorage.setItem(TAB_DIRECTORY_KEY, id || 'server');
        }
        selectedDirectoryID = id && id !== 'server' ? id : null;
        selectedDirectoryHandle = selectedDirectoryID
            ? await handleStoreRequest('readonly', store => store.get(selectedDirectoryID)) || null : null;
        return selectedDirectoryHandle;
    })();
    try { return await selectedDirectoryLoad; }
    finally { selectedDirectoryLoad = null; }
}

async function removeSavedRootDirHandle() {
    // Forget access for this tab; retain other tabs' handles and all note data.
    sessionStorage.setItem(TAB_DIRECTORY_KEY, 'server');
    selectedDirectoryHandle = null;
    selectedDirectoryID = null;
    selectedDirectoryLoad = null;
}

async function getRootDirHandle() {
    const savedDirHandle = await getSavedRootDirHandle();
    // A selected folder is authoritative. Never silently substitute the demo
    // workspace because a browser lacks an unrelated OPFS method.
    if (typeof FileSystemDirectoryHandle !== 'undefined' && savedDirHandle instanceof FileSystemDirectoryHandle) {
        return savedDirHandle;
    }
    return await getTemporaryStorageDirHandle();
}

const resizeHandle = document.querySelector('.resize');
let isResizing = false;
resizeHandle.addEventListener('mousedown', initResize);
document.addEventListener('mousemove', doResize);
document.addEventListener('mouseup', stopResize);

function initResize(e) {
    isResizing = true;
    document.body.classList.add('dragging');
    e.preventDefault();
}

function doResize(e) {
    if (!isResizing) return;

    log(e);
    const width = e.clientX;
    const minWidth = 200;
    const maxWidth = 600;

    const constrainedWidth = Math.min(Math.max(width, minWidth), maxWidth);
    sidebar.style.setProperty('width', constrainedWidth + 'px', 'important');
}

function stopResize() {
    if (!isResizing) return;
    isResizing = false;
    document.body.classList.remove('dragging');
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const openSidebar = document.getElementById('open-sidebar');

    const isHidden = sidebar.style.display === 'none'
        || getComputedStyle(sidebar).display === 'none';

    if (isHidden) {
        sidebar.style.display = 'flex';
        openSidebar.style.display = 'none';
        // Suppresses the mobile media-query that hides the sidebar.
        document.body.classList.add('sidebar-open');
    } else {
        sidebar.style.display = 'none';
        openSidebar.style.display = 'block';
        document.body.classList.remove('sidebar-open');
        currentEditor.focus();
    }
}

function trimPostfix(str, postfix) {
    if (str.endsWith(postfix)) {
        return str.slice(0, -postfix.length);
    }
    return str;
}

function trimPrefix(str, prefix) {
    if (str.startsWith(prefix)) {
        return str.slice(prefix.length);
    }
    return str;
}

function getCurrentVersion() {
    return window.COMMIT_HASH ? window.COMMIT_HASH.replace('?v=', '') : '';
}

function showEditor2() {
    const editor2Container = document.getElementById('editor2-container');
    const alreadyShown = editor2Container.classList.contains('show')
        && editor2Container.style.display !== 'none';
    if (alreadyShown) {
        return;
    }

    rememberEditorPos();

    editor2Container.style.display = 'flex';
    editor2Container.offsetHeight; // Force reflow
    editor2Container.classList.add('show');
    document.getElementById('content').classList.add('editor2-open');

    editor.refresh();
    editor2.focus();
    restoreEditorPos();
}

function hideEditor2() {
    if (typeof editor2 === 'undefined') {
        return
    }

    const editor2Container = document.getElementById('editor2-container');

    editor2Container.classList.remove('show');
    document.getElementById('content').classList.remove('editor2-open');
    restoreEditorPos();

    // Clear editor2's path so a subsequent openFile for the same path
    // doesn't take the isSameFile short-circuit (which skips re-init and
    // would leave the panel visually empty after editor1 re-init nuked
    // editor2's wrapper).
    editor2.path = undefined;
    currentEditor = editor;
    selectSidebarItem(editor.path);

    setTimeout(() => {
        editor2Container.style.display = 'none';
        editor.refresh(); // IT seems we have to refresh once size changes.
    }, 300);
}

function isChrome() {
    var winNav = window.navigator;
    var vendorName = winNav.vendor;

    var isChromium = window.chrome;
    var isOpera = typeof window.opr !== "undefined";
    var isIEedge = winNav.userAgent.indexOf("Edg") > -1;
    var isIOSChrome = winNav.userAgent.match("CriOS");
    var isGoogleChrome = isChromium !== null
        && typeof isChromium !== "undefined"
        && vendorName === "Google Inc."
        && isOpera === false
        && isIEedge === false
        && (typeof winNav.userAgentData === "undefined" || winNav.userAgentData.brands.some(x => x.brand === "Google Chrome"));

    if (isIOSChrome) {
        return true;
    } else if (isGoogleChrome) {
        return true;
    } else {
        return false;
    }
}

function goBack() {
    history.back();
}

function goForward() {
    history.forward();
}

// Returns { json, error }. On success, error is null. On HTTP error,
// json is null and error is a "<status> <statusText>: <body>" string.
async function post(endpoint, data) {
    let response;
    try {
        response = await fetch(`${API_URL}/${endpoint}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'X-FilesMD-Sync': SYNC_PROTOCOL_VERSION,
                'Content-Type': 'application/json',
                'Version': getCurrentVersion()
            },
            body: JSON.stringify(data)
        });
    } catch (e) {
        return { json: null, error: `network: ${e.message}` };
    }

    if (!response.ok) {
        let body = '';
        try { body = await response.text(); } catch (_) {}
        return { json: null, error: `${response.status} ${response.statusText}: ${body}`.trim() };
    }
    markServerOk();

    // Some endpoints (e.g. /syncMedia upload) reply 200 with an empty
    // body on success - treat that as `{}` so callers don't have to
    // care about the difference.
    let json;
    try {
        json = await response.json();
    } catch (e) {
        return { json: null, error: `parse: ${e.message}` };
    }

    // Handle special commands from server.
    // We may need to force-update sometimes.
    if (json.status === 'reload') {
        const url = new URL(window.location);
        url.searchParams.set('t', Date.now());
        window.location.href = url.toString();
    } else if (json.status === 'close') {
        window.location.href = "about:blank"
    }

    return { json, error: null };
}

// Custom global log() function that display immediate values and writes to a file.
// Logging a JavaScript object to the console isn't logging that object's state, it is logging an object reference.
// We make a deep copy of the object at the moment of calling so to display its true value.
function log(...args) {
    logf('', '#4CAF50', args);
}

function logError(...args) {
    logf('Error: ', '#F44336', args);
}

async function logf(prefix, color, args) {
    // Capture real caller from stack (skip 2 levels: _logInternal and log/error)
    const stack = new Error().stack;

    // Extract 3 and 4 lines from stack trace
    const callerFull = stack.split('\n')[3].trim(); // Real caller line
    // Extract only the last path segment
    const callerMatch = callerFull.match(/([^\/\\]+:\d+:\d+)/);
    let caller = callerMatch ? callerMatch[1] : callerFull;

    // Extract 4 if exists
    const callerFull2 = stack.split('\n')[4]?.trim();
    const caller2Match = callerFull2 ? callerFull2.match(/([^\/\\]+:\d+:\d+)/) : null;
    const caller2 = caller2Match ? caller2Match[1] : null;
    if (caller2) {
        // Append second caller for better context
        caller += ` <- ${caller2}`;
    }

    // Format message
    const msg = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    // Get time for console
    const date = new Date();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const time = `${hours}:${minutes}:${seconds}`;

    // Compact console output with colors
    console.log(
        `%c[${time}]%c ${msg}%c ${caller}`,
        'color: #888; font-size: 0.9em',      // Time in gray
        `color: ${color}; font-weight: bold`, // Message in specified color
        'color: #888; font-size: 0.9em'       // Stack trace in gray
    );

    // Diagnostics must not create or append to notes in a connected workspace.
    // In particular, upstream's Markdown log would sync itself recursively.
    if (window.FILES_MD_LOCAL_SERVER) return;

    // File logging with full timestamp
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();

    const now = `${day}.${month}.${year} ${time}`;
    const logMsg = `${now} ${prefix}[${callerFull}] ${msg}\n`;

    try {
        await writeAtEnd(LOG_PATH, logMsg);
    } catch (error) {
    }
}

let operationCounter = 0;
function opId() {
    return `${++operationCounter}`;
}

// Event listeners

// Hotkeys
window.addEventListener('keydown', async (event) => {
    if (isMetaKey(event) && event.key == 'w') {
        hideEditor2();
    }

    if (isMetaKey(event) && event.key === 'p') {
        event.preventDefault();
        event.stopPropagation();
        document.getElementById('search-input').value = ''
        searchModal.open();
    }

    if (isMetaKey(event) && event.key === 'k') {
        event.preventDefault();
        event.stopPropagation();
        document.getElementById('search-input').value = ''
        searchModal.open();
    }

    if (isMetaKey(event) && event.shiftKey && event.code === 'KeyF') {
        event.preventDefault();
        event.stopPropagation();
        searchModal.open('', true);
    }

    if (isMetaKey(event) && event.key === 'm') {
        event.preventDefault();
        event.stopPropagation();
        document.getElementById('move-input').value = ''
        moveModal.open();
    }

    if (isMetaKey(event) && event.key === 'd') {
        log('cmd+d');
        event.preventDefault();
        event.stopPropagation();
        removeCurrentFile();
    }

    if (isMetaKey(event) && event.key === 'n') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (event.shiftKey) {
            await newFolder();
        } else {
            await newFile();
        }
    }
}, true);

// Cmd/Ctrl+S: no need, everything is autosaved
document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 's') {
        event.preventDefault();
        if (!allowWorkspaceAction()) return;
        const keystroke = navigator.platform.toLowerCase().includes('mac') ? '⌘S' : 'Ctrl+S';
        showToast(`It is autosaved, no need to press ${keystroke} :)`);
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        const search = document.getElementById('search');
        const move = document.getElementById('move');
        if (search.style.display !== 'none' || move.style.display !== 'none') {
            searchModal.close();
            moveModal.close();
            currentEditor.focus();
            return;
        }
        hideEditor2();
        editor.focus();
    }
    if (isSidebarToggleShortcut(event)) {
        event.preventDefault();
        toggleSidebar();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
        document.body.classList.add('cmd-pressed');
    }
});

document.addEventListener('keyup', (e) => {
    if (!e.metaKey && !e.ctrlKey) {
        document.body.classList.remove('cmd-pressed');
    }
});

window.addEventListener('popstate', (event) => {
    const state = event.state;
    if (state) {
        openFile(state.path, false, state.el);
    }
});

// Reload files once the app gains focus.
window.addEventListener('focus', async () => {
    // Firefox can focus the page while its scripts are still initializing.
    if (!window.currentEditor) return;
    if (window.FILES_MD_LOCAL_SERVER) {
        if (localNotesInitialized) await syncLocalNotes().catch(() => {});
        return;
    }
    const userHasCustomAPIUrl = localStorage.getItem('apiUrl') !== null;
    if (isMemFS && !userHasCustomAPIUrl) return;

    log('FOCUS');

    if (currentEditor.path === undefined) {
        return;
    }

    const savedDirectoryHandle = await getRootDirHandle();
    // TODO check if access granted

    // Sync media first, so that new images for current file would be loaded
    await syncMediaFiles();
    await syncCurrentFile();

    const start = performance.now();
    files = await loadLocalFiles(savedDirectoryHandle, true);
    const end = performance.now();
    log(`Files loaded in: ${(end - start).toFixed(3)} milliseconds`);
    await syncFilesWithServer()
    await renderSidebar();
    log('Sync completed');
});

// Save pending note edits when the window loses focus.
window.addEventListener('blur', async function() {
    if (!window.currentEditor) return;
    if (window.FILES_MD_LOCAL_SERVER) {
        if (localNotesInitialized) {
            await syncCurrentFile();
            await syncLocalNotes().catch(() => {});
        }
        return;
    }
    log('BLUR');
    editor.refresh();

    // Sync media first, so that new images for current file would be loaded
    // if files is not empty object
    if (Object.keys(files).length === 0) {
        return;
    }
    await syncMediaFiles();
    await syncCurrentFile();

    const savedDirectoryHandle = await getRootDirHandle();

    // Benchmark time took
    const start = performance.now();
    files = await loadLocalFiles(savedDirectoryHandle);
    const end = performance.now();
    log(`Files loaded in: ${(end - start).toFixed(3)} milliseconds`);
    await syncFilesWithServer()
    await renderSidebar();
    log('Sync completed');
});

window.addEventListener('beforeunload', function() {
    clearInterval(window.saver);
});

// Worker to process the saving queue
window.saver = setInterval(() => {
    if (document.hasFocus()) {
        syncCurrentFile();
    }
}, CURRENT_FILE_SYNC_INTERVAL);
