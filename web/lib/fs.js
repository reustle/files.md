// Forbidden chars on Windows / PWA / Unix.
const FORBIDDEN_FILENAME_CHARS = ['<', '>', ':', '"', '|', '\\', '?', '*', '\x00', '/'];

function sanitizeFilename(filename) {
    return FORBIDDEN_FILENAME_CHARS.reduce((result, ch) => result.replaceAll(ch, ''), filename);
}

function findForbiddenChar(name) {
    for (const ch of FORBIDDEN_FILENAME_CHARS) {
        if (name.includes(ch)) return ch;
    }
    return null;
}

async function getFileHandle(path, create = false) {
    let dir, filename;
    if (path.includes('/')) {
        const parts = path.split('/');
        filename = parts.pop();
        dir = parts.join('/');
    } else {
        dir = '';
        filename = path;
    }

    const dirs = dir.split('/');
    let currentDirHandle = await getRootDirHandle();
    for (const dirName of dirs) {
        if (dirName) {
            try {
                currentDirHandle = await currentDirHandle.getDirectoryHandle(dirName, {create: create});
            } catch (error) {
                throw error;
            }
        }
    }

    let fileHandle;
    try {
        fileHandle = await currentDirHandle.getFileHandle(filename, {create: create});
    } catch (error) {
        throw error;
    }

    return fileHandle;
}

async function read(path) {
    let fileHandle = await getFileHandle(path)
    let file = await fileHandle.getFile();

    return await file.text();
}

async function write(path, content, {stageDraft = true} = {}) {
    if (stageDraft) requireWritableWorkspace();
    if (window.FILES_MD_LOCAL_SERVER && stageDraft) stageLocalDraft(path, content);
    let fileHandle = await getFileHandle(path, true);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
}

async function writeAtEnd(path, content) {
    requireWritableWorkspace();
    let fileHandle = await getFileHandle(path, true);
    if (fileHandle === null) {
        // TODO fix once Chromium fixes the bug
        throw new Error('Invalid file name');
    }

    if (window.FILES_MD_LOCAL_SERVER) {
        stageLocalDraft(path, await (await fileHandle.getFile()).text() + content);
    }
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    await writable.seek(await fileHandle.getFile().then(file => file.size));
    await writable.write(content);
    await writable.close();

    const file = await fileHandle.getFile();
    return file.lastModified;
}

// TODO save metadata & files
// Write only if content is different.
async function writeIfContentIsDifferent(path, content, {stageDraft = true} = {}) {
    if (stageDraft) requireWritableWorkspace();
    if (window.FILES_MD_LOCAL_SERVER && stageDraft) stageLocalDraft(path, content);
    let fileHandle = await getFileHandle(path, true);
    if (fileHandle === null) {
        // TODO fix once Chromium fixes the bug
        throw new Error('Invalid file name');
    }

    if (!await isContentEqual(path, content, !window.FILES_MD_LOCAL_SERVER)) {
        // TODO what if we're syncing first time and already have changes?
        log('Hashes do not match, writing file...', path);
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    } else {
        log('Hashes match, no need to write file.');
    }

    const file = await fileHandle.getFile();
    return file.lastModified;
}

// Works only for files.
async function exists(path) {
    try {
        await getFileHandle(path);
        return true;
    } catch (error) {
        if (error.name === 'NotFoundError') {
            return false
        }
        throw error
    }
}

async function remove(path, {moveTo = null, syncDeletion = true} = {}) {
    if (syncDeletion) requireWritableWorkspace();
    const nativeDraftsToRetire = hasSelectedDiskFolder()
        ? nativeDraftEntries(path).filter(entry => entry.draft.tab === localMirrorID) : [];
    let fileHandle = await getFileHandle(path);
    if (fileHandle === null) {
        // TODO fix once Chromium fixes the bug
        logError('Malformed name, skipping file...');
        return;
    }
    const baseline = window.FILES_MD_LOCAL_SERVER && !hasSelectedDiskFolder()
        ? localDrafts[path]?.version ?? getServerFile(path)?.version : getServerFile(path)?.lastModified;
    if (typeof fileHandle.remove === 'function') {
        await fileHandle.remove();
    } else {
        const parts = path.split('/').filter(Boolean);
        const filename = parts.pop();
        let dir = await getRootDirHandle();
        for (const name of parts) dir = await dir.getDirectoryHandle(name);
        await dir.removeEntry(filename);
    }
    if (syncDeletion && baseline) pendingFileDeletes.set(path, baseline);
    if (syncDeletion && window.FILES_MD_LOCAL_SERVER && !hasSelectedDiskFolder()) {
        if (baseline) stageLocalDelete(path, baseline);
        else {
            delete localDrafts[path];
            persistLocalDrafts();
        }
    }
    if (!moveTo) for (const entry of nativeDraftsToRetire) retireNativeDraft(entry);
    if (syncDeletion && moveTo && !hasSelectedDiskFolder()) recordFileMove(path, moveTo);
    log(`File ${path} removed successfully.`);

    removeMemFile(path);
}

async function rename(oldpath, newpath) {
    requireWritableWorkspace();
    let content = await read(oldpath)
    await write(newpath, content)
    await remove(oldpath, {moveTo: newpath})
}

// Only explicitly enumerated files are removed. A failed file operation or
// an unsupported file left in the folder must never trigger recursive deletion.
async function removeDir(dirPath) {
    requireWritableWorkspace();
    const filePaths = collectFilePathsInDir(dirPath);
    for (const path of filePaths) await remove(path);
    await removeEmptyDirectoryTree(dirPath);
    removeMemDir(dirPath);
}

async function removeEmptyDirectoryTree(dirPath) {
    requireWritableWorkspace();
    const parts = dirPath.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error('Cannot remove the notes root');
    let parent = await getRootDirHandle();
    for (const part of parts) parent = await parent.getDirectoryHandle(part);
    const dir = await parent.getDirectoryHandle(name);
    for await (const entry of dir.values()) {
        if (entry.kind === 'directory') await removeEmptyDirectoryTree(joinPath(dirPath, entry.name));
    }
    // This fails if any file remains, including files the app doesn't support.
    await parent.removeEntry(name);
    stageLocalDirectory(dirPath, 'rmdir');
}

// moveDir moves every file under oldDirPath into newDirPath, which can be in
// any parent (including a different one). Per-file moves keep server-sync
// bookkeeping intact; afterwards the empty old directory entry is removed.
async function moveDir(oldDirPath, newDirPath) {
    requireWritableWorkspace();
    if (newDirPath === oldDirPath) return;
    // Disallow moving a folder into itself or any of its own descendants -
    // we'd otherwise loop forever copying the dir into a subpath of itself.
    if (newDirPath === oldDirPath + '/' || newDirPath.startsWith(oldDirPath + '/')) {
        logError('moveDir: refusing to move dir into itself', oldDirPath, newDirPath);
        return;
    }

    const filePaths = collectFilePathsInDir(oldDirPath);
    const directories = [oldDirPath];
    walk(files, (path, isFile) => {
        if (!isFile && path.startsWith(oldDirPath + '/')) directories.push(removeTrailingSlash(path));
    });
    for (const path of directories) await createDir(newDirPath + path.slice(oldDirPath.length));
    for (const oldFilePath of filePaths) {
        await moveFile(oldFilePath, newDirPath + oldFilePath.slice(oldDirPath.length));
    }

    await removeEmptyDirectoryTree(oldDirPath);

    removeMemDir(oldDirPath);
    log(`Dir ${oldDirPath} moved to ${newDirPath}.`);
}

// renameDir moves every file under oldDirPath into a sibling directory called
// newName.
async function renameDir(oldDirPath, newName) {
    requireWritableWorkspace();
    const parts = trimPrefix(oldDirPath, '/').split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    const newDirPath = joinPath(parentPath, newName);
    await moveDir(oldDirPath, newDirPath);
}

// collectFilePathsInDir returns absolute paths of every file under dirPath,
// using the in-memory file tree so we don't hit OPFS for the listing.
function collectFilePathsInDir(dirPath) {
    const collected = [];
    walk(files, (p, isFile) => {
        if (!isFile || (window.FILES_MD_LOCAL_SERVER && !isNotePath(p))) return;
        if (p === dirPath || p.startsWith(dirPath + '/')) {
            collected.push(p);
        }
    });
    return collected;
}

// removeMemDir drops a directory subtree from the in-memory file map.
function removeMemDir(dirPath) {
    const parts = trimPrefix(dirPath, '/').split('/').filter(Boolean);
    const dirName = parts.pop();
    let cur = files;
    for (const seg of parts) {
        cur = cur[seg + '/'];
        if (!cur) return;
    }
    delete cur[dirName + '/'];
}

async function mkdir(path) {
    requireWritableWorkspace();
    try {
        let currentDirHandle = await getRootDirHandle();
        await currentDirHandle.getDirectoryHandle(path, {create: true});
    } catch (e) {
        logError(e);
        throw e;
    }
}

async function mkdirAll(path) {
    requireWritableWorkspace();
    const dirs = path.split('/');
    let currentDirHandle = await getRootDirHandle();
    for (const dirName of dirs) {
        if (dirName) {
            await mkdir(path)
        }
    }
}

// createDir creates an empty directory on OPFS at the given path and registers
// it in the in-memory file tree so the sidebar picks it up.
async function createDir(dirPath, {syncDirectory = true} = {}) {
    if (syncDirectory) requireWritableWorkspace();
    const parts = trimPrefix(dirPath, '/').split('/').filter(Boolean);
    if (parts.length === 0) return;
    if (syncDirectory) stageLocalDirectory(dirPath, 'mkdir');

    let dirHandle = await getRootDirHandle();
    for (const seg of parts) {
        dirHandle = await dirHandle.getDirectoryHandle(seg, { create: true });
    }

    let cur = files;
    for (const seg of parts) {
        const key = seg + '/';
        if (!cur[key]) cur[key] = {};
        cur = cur[key];
    }
    log(`Dir ${dirPath} created.`);
}

async function writeMediaFile(fileName, file) {
    requireWritableWorkspace();
    try {
        const rootHandle = await getRootDirHandle();

        let mediaHandle;
        try {
            mediaHandle = await rootHandle.getDirectoryHandle('media');
        } catch {
            mediaHandle = await rootHandle.getDirectoryHandle('media', {create: true});
        }

        const fileHandle = await mediaHandle.getFileHandle(fileName, {create: true});
        const writable = await fileHandle.createWritable();
        await writable.write(file);
        await writable.close();

        const path = '/media/' + fileName;
        addMemFile(path, {
            isFile: true,
            path: path,
            imageUrl: await getImageUrl(fileHandle),
        });

        return fileHandle;
    } catch (error) {
        logError('Error saving file:', error);
        return null;
    }
}

function generateSafeFilename(originalName) {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ext = originalName.includes('.') ? originalName.split('.').pop() : 'png';
    return `${dd}.${mm}.${yyyy} ${hh}h${mi}m${ss}s.${ext}`;
}
