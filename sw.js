/* sw.js — cache-first service worker.
 *
 * !! BUMP CACHE_VERSION ON EVERY DEPLOY !!
 *
 * Cache-first means a cached file is served without ever asking the network.
 * With no build step there is nothing to fingerprint the filenames, so the
 * ONLY thing that gets a change onto the phone is a new cache name. Forget
 * this and the app on your home screen stays frozen at the old version
 * indefinitely, with no error to tell you why.
 */

var CACHE_VERSION = 'v66-practice-log-20261022b';
var CACHE = 'repertoire-' + CACHE_VERSION;

var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ui.js',
  './seed.json',
  './manifest.json',
  './icon-192-gold.png',
  './icon-512-gold.png',
  './apple-touch-icon-gold.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      /* Fetch a complete release before activating. A missing asset leaves
         the previous offline release available; local practice data is separate. */
      .then(function (c) {
        return Promise.all(ASSETS.map(function (url) {
          return fetch(new Request(url, { cache: 'reload' }))
            .then(function (res) {
              if (!res || !res.ok) throw new Error('Incomplete app update: ' + url);
              return c.put(url, res);
            });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        /* Cache same-origin successes as they are discovered, so a file added
           after install still works offline next time. */
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        /* Offline and uncached: for a navigation, fall back to the shell so
           the app still opens. */
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});

/* Lets the page trigger an immediate update instead of waiting for a restart. */
self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
