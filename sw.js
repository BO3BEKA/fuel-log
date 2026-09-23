// sw.js — makes Fuel Log launch instantly and work with no signal.
//
// Bump CACHE_VERSION on every deploy. That is the whole update mechanism: the
// new version installs in the background, the app notices and offers a Reload,
// and old caches are deleted on activation. It replaces the ?v=N trick.

const CACHE_VERSION = 'fuel-log-v9';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const VENDOR_CACHE = `${CACHE_VERSION}-vendor`;

// Everything needed to boot with no network at all.
const SHELL = [
  './',
  './index.html',
  './store.js',
  './portions.js',
  './nutrients.js',
  './insights.js',
  './foodsearch.js',
  './scanner.js',
  './firebase-config.js',
  './app-config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
];

// Third-party code at pinned versions. Worth caching hard — it is what makes
// the scanner and the fonts work offline.
const VENDOR_HOSTS = [
  'cdn.jsdelivr.net',      // ZXing, pinned to an exact version
  'www.gstatic.com',       // Firebase SDK, pinned to an exact version
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// Live data and auth. These must never be served from a cache — Firestore runs
// its own offline persistence in IndexedDB and intercepting it breaks sync.
const NEVER_CACHE_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'world.openfoodfacts.org',
  'api.nal.usda.gov',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the entire install if one file 404s, leaving no offline
    // support at all. Fetch individually and tolerate gaps.
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (e) {
        console.warn('[sw] could not precache', url, e);
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !n.startsWith(CACHE_VERSION)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Lets the page apply an update the moment the user taps Reload.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return; // straight to network

  if (VENDOR_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

// Pinned third-party files never change, so the cache wins and the network is
// only touched on a miss.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
    return res;
  } catch {
    return new Response('Offline and not cached', { status: 503, statusText: 'Offline' });
  }
}

// Our own files change on every deploy, so the network wins and the cache is
// the offline fallback. The timeout stops a flaky connection hanging the app
// when a perfectly good cached copy exists.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await withTimeout(fetch(request), 4000);
    if (res && res.ok) { cache.put(request, res.clone()); return res; }
    if (res) return res;
  } catch { /* fall through to the cache */ }

  const hit = await cache.match(request);
  if (hit) return hit;

  // A reload or deep link while offline still needs the shell.
  if (request.mode === 'navigate') {
    const shell = (await cache.match('./index.html')) || (await cache.match('./'));
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
