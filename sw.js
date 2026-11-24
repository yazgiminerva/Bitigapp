const CACHE = 'kitapligim-v13';
const SHELL = ['./', './index.html', './zxing.min.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './splash.jpg', './cornice.jpg', './cabinet.jpg', './wood-v.jpg', './wood-h.jpg', './wood-h-light.jpg', './leather.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!own && !font) return; // book lookups and covers go straight to the network
  // The page itself: always try the network first (skipping the browser's 10-minute cache),
  // so a new version shows up on the next open; fall back to the saved copy when offline.
  if (own && (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html'))) {
    e.respondWith(fetch(req, {cache: 'no-cache'}).then(r => { if (r.ok) caches.open(CACHE).then(c => c.put('./index.html', r.clone())); return r; })
      .catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
    return;
  }
  // Everything else: serve the saved copy at once and refresh it in the background
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req, {ignoreSearch: own});
    const net = fetch(req, own ? {cache: 'no-cache'} : {}).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
