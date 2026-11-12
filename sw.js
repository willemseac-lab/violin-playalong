// Offline support when the app is hosted on https (phone install).
const CACHE = 'vpa-v6';
const SOUNDS = ["sounds/bassoon.mp3", "sounds/cello.mp3", "sounds/clarinet.mp3", "sounds/contrabass.mp3", "sounds/flute.mp3", "sounds/guitar.mp3", "sounds/harp.mp3", "sounds/horn.mp3", "sounds/piano.mp3", "sounds/sax.mp3", "sounds/trombone.mp3", "sounds/trumpet.mp3", "sounds/tuba.mp3", "sounds/violin.mp3"];
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'lib/vexflow-bravura.js', 'lib/jszip.min.js', 'lib/lamejs.iife.js', 'lib/mp4-muxer.js', 'js/video.js', 'demo/demos.js',
  'js/theory.js', 'js/player.js', 'js/score.js', 'js/arrange.js', 'js/store.js', 'js/tools.js', 'js/exports.js', 'js/practice.js', 'js/stage.js', 'lib/jspdf.umd.min.js', 'sounds/sounds.js', 'js/app.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.concat(SOUNDS))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
