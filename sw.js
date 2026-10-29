// Fastreading – Service Worker: hält die App offline verfügbar.
// Stale-while-revalidate: sofort aus dem Cache antworten, im Hintergrund aktualisieren.
// Neue Versionen sind dadurch ab dem übernächsten Öffnen aktiv.

const CACHE = 'fastreading-v1';
const ASSETS = [
    './',
    'index.html',
    'extract.js',
    'manifest.webmanifest',
    'icons/icon-180.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'vendor/pdfjs/pdf.min.js',
    'vendor/pdfjs/pdf.worker.min.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

    event.respondWith(caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request, { ignoreSearch: true });
        const network = fetch(request)
            .then((response) => {
                if (response.ok) cache.put(request, response.clone());
                return response;
            })
            .catch(() => cached || Response.error());
        if (!cached) return network;
        event.waitUntil(network);
        return cached;
    }));
});
