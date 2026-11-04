// We need our application to work offline, so we install a service worker.
// Server worker intercept calls to the specified urls and returns cached copies.

// Web folder is our doc root.
const urlsToCache = [
    '/',
    '/favicon.ico',
    '/favicon.svg',
    '/img/icon.png',
    '/img/icon_small.png',
    '/manifest.json',
    '/app.css',
    '/lib/normalize.css',
    '/lib/sidebar.css',
    '/lib/codemirror.css',
    '/lib/hypermd.css',
    '/lib/theme-light.css',
    '/lib/theme-dark.css',
    '/lib/theme-brutal.css',
    '/lib/theme-brutal-dark.css',
    '/lib/sidebar.js',
    '/lib/codemirror.js',
    '/lib/core.js',
    '/lib/markdown.js',
    '/lib/hypermd.js',
    '/lib/keymap.js',
    '/lib/click.js',
    '/lib/hide-token.js',
    '/lib/fold.js',
    '/lib/fold-image.js',
    '/lib/fold-link.js',
    '/lib/fold-code.js',
    '/lib/hypermd-mermaid.js',
    // mermaid.min.js intentionally NOT pre-cached; lazy-loaded on first use
    // and the SW's dynamic fetch handler caches it at that point.
    '/lib/autocomplete-link.js',
    '/lib/show-hint.js',
    '/lib/autoscroll.js',
    '/lib/codemirror-go.js',
    '/lib/codemirror-python.js',
    '/lib/codemirror-javascript.js',
    '/lib/codemirror-php.js',
    '/lib/codemirror-shell.js',
    '/lib/similarity.js',
    '/lib/emoji.js',
    '/lib/fs.js',
    '/lib/md.js',
    '/app.js',
    '/welcome.js',
    '/server-config.js',
    '/files.js',
    '/local-sync.js',
    '/native-drafts.js',
    '/editor.js',
    '/modals.js',
    '/lib/latex/fold-math.js',
    '/lib/latex/katex.min.js',
    '/lib/latex/katex.min.css',
    '/lib/latex/KaTeX_AMS-Regular.woff2',
    '/lib/latex/KaTeX_Caligraphic-Bold.woff2',
    '/lib/latex/KaTeX_Caligraphic-Regular.woff2',
    '/lib/latex/KaTeX_Fraktur-Bold.woff2',
    '/lib/latex/KaTeX_Fraktur-Regular.woff2',
    '/lib/latex/KaTeX_Main-Bold.woff2',
    '/lib/latex/KaTeX_Main-BoldItalic.woff2',
    '/lib/latex/KaTeX_Main-Italic.woff2',
    '/lib/latex/KaTeX_Main-Regular.woff2',
    '/lib/latex/KaTeX_Math-BoldItalic.woff2',
    '/lib/latex/KaTeX_Math-Italic.woff2',
    '/lib/latex/KaTeX_SansSerif-Bold.woff2',
    '/lib/latex/KaTeX_SansSerif-Italic.woff2',
    '/lib/latex/KaTeX_SansSerif-Regular.woff2',
    '/lib/latex/KaTeX_Script-Regular.woff2',
    '/lib/latex/KaTeX_Size1-Regular.woff2',
    '/lib/latex/KaTeX_Size2-Regular.woff2',
    '/lib/latex/KaTeX_Size3-Regular.woff2',
    '/lib/latex/KaTeX_Size4-Regular.woff2',
    '/lib/latex/KaTeX_Typewriter-Regular.woff2',
    '/lib/table.js',

];

const urlParams = new URLSearchParams(self.location.search);
const COMMIT_HASH = urlParams.get('v') ? `?v=${urlParams.get('v')}` : '';

const cacheName = `files-md-v${COMMIT_HASH}`;

// Pre-fetch every file in urlsToCache so the app works offline right after the
// first visit. Without this, *.js files would be requested before SW is ready,
// and thus not cached and ready for offline.
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        let cache;
        try {
            cache = await caches.open(cacheName);
        } catch (err) {
            logError('Failed to open cache:', err);
            return;
        }

        for (let url of urlsToCache) {
            // KaTeX fonts are referenced by katex.min.css with no version param,
            // so the cache key must match (no hash appended either).
            const shouldAddRevisionHash = url !== "/" && url !== 'favicon.ico' && url !== 'favicon.svg' && !url.startsWith('/img/') && !url.endsWith('.woff2');
            if (shouldAddRevisionHash) {
                url = url + COMMIT_HASH;
            }

            try {
                await cache.add(url);
            } catch (err) {
                console.error('✗ Failed to cache:', url, err);
            }
        }

        return await self.skipWaiting();
    })());
});

self.addEventListener("activate", (event) => {
    console.log("Service worker is activated");

    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return cacheNames.map((cache) => {
                if (cache !== cacheName) {
                    caches.delete(cache);
                }
            });
        })
    );
});

self.addEventListener("fetch", (event) => {
    // Authenticated state and endless event streams must always reach the server.
    const requestURL = new URL(event.request.url);
    if (requestURL.pathname === '/session' || requestURL.pathname.startsWith('/notes/') ||
        requestURL.pathname === '/server-config.js' || requestURL.searchParams.has('token')) return;
    // Skip non-GET requests and extensions
    if (event.request.method !== 'GET' ||
        event.request.url.startsWith('chrome-extension:') ||
        event.request.url.startsWith('moz-extension:')) {
        return;
    }

    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    for (let i = 0; i < 3; i++) {
        try {
            const response = await fetch(request);
            // In South America I had poor internet connection, and some js files
            // were partly loaded/cached :( It seems like Chromium fires
            // range requests for some files.
            if (response.status === 206) {
                console.warn('⚠️ Partial content (206), not caching:', request.url);
                return response;
            }

            if (response.ok) {
                const cache = await caches.open(cacheName);
                await cache.put(request, response.clone());
            }

            return response;

        } catch (error) {
            if (i === 2) {
                console.log(`Using cache`, error);
                return await caches.match(request);
            }

            console.warn(`Fetch failed (attempt ${i + 1}), retrying...`, error);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}
