class SearchModal {
    static RECENT_RESULTS = 15;

    constructor() {
        this.focusedIndex = 0;
        this.searchId = 0;
        this.fullText = false;
        this.init();
    }

    init() {
        document.getElementById('search').addEventListener('keydown', (event) => {
            const resultsList = document.getElementById('search-results').querySelectorAll('li');

            if (event.key === 'Enter') {
                event.preventDefault();
                this.handleEnterKey();
            }

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.focusedIndex = (this.focusedIndex + 1) % resultsList.length;
                this.updateFocusedItem();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                this.focusedIndex = (this.focusedIndex - 1 + resultsList.length) % resultsList.length;
                this.updateFocusedItem();
            }

            if (event.key === 'Escape') {
                this.close();
                event.preventDefault();
                event.stopPropagation();
                currentEditor.focus();
            }
        });

        // Close on outside click
        document.addEventListener('click', (event) => {
            const searchModal = document.getElementById('search');
            if (searchModal.style.display !== 'none' && !searchModal.contains(event.target)) {
                this.close();
            }
        });
    }

    search() {
        const searchId = ++this.searchId;
        let search = document.getElementById('search-input').value.toLowerCase();

        const list = document.getElementById('search-results');
        list.innerHTML = '';

        if (this.fullText) {
            this.focusedIndex = 0;
            this.searchContent(searchId);
            return;
        }

        if (search.endsWith('/')) {
            const folderName = search;

            // Check if the folder exists in files
            if (files[folderName]) {
                const list = document.getElementById('search-results');
                list.innerHTML = '';

                // Get all files from the specified folder
                const folderResults = [];
                for (const filename in files[folderName]) {
                    if (!files[folderName][filename].isFile) continue;
                    folderResults.push({
                        path: joinPath('/', folderName, filename),
                        score: 100 // Give max score since it's an exact folder match
                    });
                }

                this.showResults(folderResults);
                return;
            }
        }

        let results = [];
        const lowPriorityDirs = ['archive', 'habits', 'triggers'];
        let searchDirs= excludeDirs(SYSTEM_DIRS);
        const searchHasSlash = search.includes('/') && search.split('/').length === 2;
        if (searchHasSlash) {
            searchDirs = search.split('/')[0];
            search = search.split('/')[1].toLowerCase();
        }

        // Similarity matching, check for direct file matches across directories.
        walkFilesExcludingSystemDirs((path) => {
            // Ignore if not in searched dirs
            let dirName = toRootDirName(path);
            if (!searchDirs.includes(dirName)) {
                return;
            }

            const potentialMatch = toFilename(path).replace(/\.md$/, '');
            let similarityScore = similarity(search, potentialMatch);
            if (similarityScore >= 70) {
                if (lowPriorityDirs.includes(dirName)) {
                    similarityScore -= 60;
                }
                results.push({
                    path: path, score: similarityScore
                });
            }
        });

        // If search is equal to directory
        // TODO multidir?
        if (files[search]) {
            for (const filename in files[search]) {
                results.push({
                    path: joinPath('/', search, filename),
                    score: 100
                });
            }
        }

        // Check for "dir file" pattern (space separated)
        const spaceIndex = search.indexOf(' ');
        if (spaceIndex !== -1) {
            const dirName = search.substring(0, spaceIndex);
            const fileName = search.substring(spaceIndex + 1);

            if (files[dirName]) {
                for (const filename in files[dirName]) {
                    const potentialMatch = filename.replace(/\.md$/, '');
                    if (potentialMatch.toLowerCase().includes(fileName.toLowerCase())) {
                        results.push({
                            path: joinPath('/', dirName, filename),
                            score: 95
                        });
                    }
                }
            }
        }

        // Substring matching
        // for (const dir in files) {
        //     // If dir is not in search dirs, skip
        //     if (dir === 'media') {
        //         continue;
        //     }
        //
        //
        //     for (const filename in files[dir]) {
        walk(files, (path, isFile) => {
            if (!isFile) {
                return;
            }

            const dirName = toRootDirName(path);
            if (dirName === 'media') {
                return;
            }

            const filename = toFilename(path);
            const potentialMatch = trimPostfix(filename, '.md');
            const isSubstringMatch = potentialMatch.toLowerCase().includes(search.toLowerCase());
            if (!isSubstringMatch) {
                return;
            }

            let matchedPercent = (search.length / potentialMatch.length) * 100;
            if (lowPriorityDirs.includes(dirName)) {
                matchedPercent /= 5;
            }
            results.push({
                filename: filename, path: path, score: Math.round(matchedPercent)
            });
        });

        const uniqueResultsMap = new Map();
        for (let i = 0; i < results.length; i++) {
            const item = results[i];
            const key = item.path;

            if (!uniqueResultsMap.has(key) || uniqueResultsMap.get(key).score < item.score) {
                uniqueResultsMap.set(key, item);
            }
        }
        results = Array.from(uniqueResultsMap.values()).sort((a, b) => b.score - a.score);
        searchModal.showResults(results);
    }

    async searchContent(searchId) {
        const query = document.getElementById('search-input').value.toLowerCase();
        if (query.length < 3) return;

        await new Promise(r => setTimeout(r, 150));
        if (searchId !== this.searchId) return;

        const paths = [];
        walkFilesExcludingSystemDirs(path => {
            if (path.endsWith('.md')) paths.push(path);
        });

        const matches = [];
        await Promise.all(paths.map(async path => {
            try {
                const text = await (await getMemFile(path).handle.getFile()).text();
                const lower = text.toLowerCase();
                const idx = lower.indexOf(query);
                if (idx === -1) return;
                const line = lower.slice(0, idx).split('\n').length - 1;
                const col = idx - (lower.lastIndexOf('\n', idx) + 1);
                const lineText = text.split('\n')[line] || '';
                const from = Math.max(0, col - 60);
                const to = col + query.length + 160;
                matches.push({
                    path, line,
                    before: (from > 0 ? '…' : '') + lineText.slice(from, col).trimStart(),
                    match: lineText.slice(col, col + query.length),
                    after: lineText.slice(col + query.length, to) + (to < lineText.length ? '…' : ''),
                });
            } catch (e) {
            }
        }));
        if (searchId !== this.searchId) return;

        const list = document.getElementById('search-results');
        matches.sort((a, b) => a.path.localeCompare(b.path)).forEach(({path, line, before, match, after}) => {
            const item = document.createElement('li');
            item.className = 'content-match';
            const snippetEl = document.createElement('div');
            snippetEl.className = 'content-match-snippet';
            const mark = document.createElement('mark');
            mark.textContent = match;
            snippetEl.append(before, mark, after);
            const pathEl = document.createElement('div');
            pathEl.className = 'content-match-path';
            pathEl.textContent = trimPrefix(trimPostfix(path, '.md'), '/');
            item.append(snippetEl, pathEl);
            item.setAttribute('data-path', path);
            item.setAttribute('data-line', line);
            item.onclick = () => this.openResult(path, line);
            item.onmousemove = () => {
                this.focusedIndex = Array.from(list.children).indexOf(item);
                this.updateFocusedItem();
            };
            list.appendChild(item);
        });
        this.updateFocusedItem();
    }

    open(text = '', fullText = false) {
        moveModal.close();
        this.fullText = fullText;
        const modal = document.getElementById('search');
        modal.style.display = 'flex';
        modal.style.top = '30%';
        modal.style.left = '50%';
        modal.style.transform = 'translate(-50%, 0)';
        const input = document.getElementById('search-input');
        input.value = text;
        input.placeholder = fullText ? 'Search in files...' : 'Go to file...';
        input.focus();
        this.focusedIndex = 0;
        document.getElementById('search-results').innerHTML = '';
        if (text === '' && fullText) ++this.searchId;
        else if (text === '') this.showRecentFiles();
        else this.search();
    }

    close() {
        document.getElementById('search').style.display = 'none';
    }

    showResults(results) {
        const list = document.getElementById('search-results');
        list.innerHTML = '';
        for (const {path} of results) {
            if (path === CONFIG_PATH) continue;
            const item = document.createElement('li');
            const title = trimPostfix(trimPostfix(toFilename(path), '.md'), '.txt');
            const dir = toDirPath(path);
            item.textContent = dir === '/' ? title : trimPrefix(`${dir}/${title}`, '/');
            item.setAttribute('data-path', path);
            item.onclick = () => this.openResult(path);
            item.onmousemove = () => {
                this.focusedIndex = Array.from(list.children).indexOf(item);
                this.updateFocusedItem();
            };
            list.appendChild(item);
        }
        this.focusedIndex = 0;
        this.updateFocusedItem();
    }

    async openResult(path, line) {
        await openFile(path);
        if (line !== undefined) {
            currentEditor.setCursor({line, ch: 0});
            currentEditor.scrollIntoView(null, currentEditor.getScrollInfo().clientHeight / 2);
        }
        this.close();
    }

    handleEnterKey() {
        const resultsList = document.getElementById('search-results').querySelectorAll('li');
        const item = resultsList[this.focusedIndex];
        if (!item) return;
        const path = item.getAttribute('data-path');
        const line = item.getAttribute('data-line');
        this.openResult(path, line === null ? undefined : Number(line));
    }

    updateFocusedItem() {
        const resultsList = document.getElementById('search-results').querySelectorAll('li');
        document.querySelectorAll('#search-results li').forEach(li => li.classList.remove('focused'));
        resultsList.forEach((item, index) => {
            if (index === this.focusedIndex) {
                item.classList.add('focused');
                item.scrollIntoView({block: 'nearest'});
            } else {
                item.classList.remove('focused');
            }
        });
    }

    showRecentFiles() {
        let results = [];
        walkFilesExcludingSystemDirs((path) => {
            results.push({
                path: path,
                lastModified: getMemFile(path).lastModified,
            })
        });

        results = results
            .sort((a, b) => b.lastModified - a.lastModified)
            .slice(0, SearchModal.RECENT_RESULTS);

        this.showResults(results);
    }
}


class MoveModal {
    constructor() {
        this.focusedIndex = 0;
        this.init();
    }

    init() {
        document.getElementById('move-input').addEventListener('keydown', (event) => {
            const resultsList = document.getElementById('move-results').querySelectorAll('li');

            if (event.key === 'Enter') {
                event.preventDefault();
                this.handleEnterKey();
            }

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.focusedIndex = (this.focusedIndex + 1) % resultsList.length;
                this.updateFocusedItem();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                this.focusedIndex = (this.focusedIndex - 1 + resultsList.length) % resultsList.length;
                this.updateFocusedItem();
            }

            if (event.key === 'Escape') {
                this.close();
                event.preventDefault();
                event.stopPropagation();
                currentEditor.focus();
            }
        });

        document.getElementById('move-input').addEventListener('input', () => {
            this.suggestMove();
        });

        // Close on outside click
        document.addEventListener('click', (event) => {
            const moveModal = document.getElementById('move');
            if (moveModal.style.display !== 'none' && !moveModal.contains(event.target)) {
                this.close();
            }
        });
    }

    open() {
        if (!canModifyWorkspace()) { showToast('Connect to a folder on disk before changing files.'); return; }
        searchModal.close();

        let modal = document.getElementById('move');
        modal.style.display = 'flex';

        const inputField = document.getElementById('move-input');
        inputField.focus();

        modal.style.position = 'fixed';
        modal.style.top = '30%';
        modal.style.left = '50%';
        modal.style.right = '';
        modal.style.transform = 'translate(-50%, 0)';
        modal.style.width = '';
        modal.classList.remove('modal-reversed');

        this.focusedIndex = 0;
        const moveResults = document.getElementById('move-results');
        moveResults.innerHTML = '';
        this.showResults(this.getMoveDestinations());
    }

    close() {
        document.getElementById('move').style.display = 'none';
        document.getElementById('move').classList.remove('modal-reversed');
    }

    getMoveDestinations() {
        let dirs = ['/'];
        for (const dir of Object.keys(files)) {
            if (!dir.endsWith('/')) {
                continue;
            }

            if (dir === 'media/') {
                continue;
            }
            dirs.push(trimPostfix(dir, '/'));
        }

        // Place _read_ etc in the end
        dirs.sort((a, b) => {
            return a.includes('_') - b.includes('_') || a.localeCompare(b);
        });

        return dirs;
    }

    suggestMove() {
        const search = document.getElementById('move-input').value.toLowerCase();
        if (search.trim() === '') {
            this.showResults(this.getMoveDestinations());
            return;
        }

        let dirs = this.getMoveDestinations();
        dirs = dirs.filter(dir => dir.toLowerCase().startsWith(search));

        this.showResults(dirs);
    }

    showResults(dirs) {
        const list = document.getElementById('move-results');
        list.innerHTML = '';

        dirs.forEach((dir, index) => {
            let dataDir = dir;
            if (dataDir === '/') {
                dataDir = '';
            }

            const listItem = document.createElement('li');
            listItem.textContent = dir;
            listItem.setAttribute('data-path', dataDir);
            listItem.onclick = () => this.moveToDir(dir);

            listItem.onmousemove = () => {
                document.querySelectorAll('#move-results li').forEach(li => li.classList.remove('focused'));
                listItem.classList.add('focused');
                this.focusedIndex = index;
            };

            list.appendChild(listItem);
        });

        this.focusedIndex = 0;
        this.updateFocusedItem();
    }

    handleEnterKey() {
        const resultsList = document.getElementById('move-results').querySelectorAll('li');
        if (resultsList[this.focusedIndex]) {
            const toDir = resultsList[this.focusedIndex].getAttribute('data-path');
            this.moveToDir(toDir);
        }
    }

    updateFocusedItem() {
        const resultsList = document.getElementById('move-results').querySelectorAll('li');
        document.querySelectorAll('#move-results li').forEach(li => li.classList.remove('focused'));
        resultsList.forEach((item, index) => {
            if (index === this.focusedIndex) {
                item.classList.add('focused');
                item.scrollIntoView({block: 'nearest'});
            } else {
                item.classList.remove('focused');
            }
        });
    }

    moveToDir(toDir) {
        log('CLICKED ON folder to move', toDir);
        moveCurrentFile(toDir).then(() => {
            this.close();
        });
    }
}

const searchModal = new SearchModal();
const moveModal = new MoveModal();
