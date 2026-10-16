/**
 * LyricWave Service Worker (PWA Offline & Shell Caching)
 */

const CACHE_NAME = 'lyricwave-v23';
const STATIC_ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './styles.css',
  './config.js',
  './auth.js',
  './user-auth.js',
  './types.js',
  './engine.js',
  './lyrics.js',
  './reel.js',
  './translate.js',
  './audio-reactive.js',
  './visuals.js',
  './card.js',
  './mic.js',
  './shazam-core.js',
  './projectm-visualizer.js',
  './search.js',
  './lastfm.js',
  './spotify-source.js',
  './phone-source.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests; never intercept or cache POST/PUT/DELETE
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // Bypass service worker caching for external APIs, streaming audio, and backend functions
  if (
    url.hostname.includes('spotify.com') ||
    url.hostname.includes('lrclib.net') ||
    url.hostname.includes('audioscrobbler.com') ||
    url.hostname.includes('apple.com') ||
    url.hostname.includes('deezer.com') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  // Stale-While-Revalidate for app assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          // If offline and request is for page navigation, fallback to cached index.html
          if (event.request.mode === 'navigate') {
            return (await caches.match('./index.html')) || (await caches.match('/index.html'));
          }
          return cachedResponse || new Response('Network error occurred.', { status: 503, statusText: 'Service Unavailable' });
        });

      return cachedResponse || fetchPromise;
    })
  );
});
