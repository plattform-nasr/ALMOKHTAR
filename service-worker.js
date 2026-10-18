/* =========================================================
   Math Center Platform — Service Worker
   Exists mainly so Chrome/Android considers the site
   "installable" (PWA install banner). Keeps things simple:
   network-first for everything, with a tiny fallback cache
   for the app shell so a repeat visit still opens if the
   network briefly drops. It never caches Firebase requests,
   so live data (students/attendance/grades/...) always comes
   from the network — nothing here can go stale.
   ========================================================= */

const CACHE_NAME = 'mc-shell-v1';
const SHELL_FILES = [
  './index.html',
  './shared.css',
  './shared.js',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(SHELL_FILES); })
      .catch(function () { /* ok if some shell file 404s (paths vary per deploy) */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var url = event.request.url;

  // Never touch Firebase / Google APIs / EmailJS — always live network.
  if (url.indexOf('firebaseio.com') !== -1 ||
    url.indexOf('googleapis.com') !== -1 ||
    url.indexOf('gstatic.com') !== -1 ||
    url.indexOf('emailjs.com') !== -1) {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        return response;
      })
      .catch(function () { return caches.match(event.request); })
  );
});
