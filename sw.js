/**
 * Robot 3C · service worker.
 * Solo guarda la pantalla (HTML, ícono, manifest) para que la app abra sin internet.
 * Los pedidos al servidor NUNCA se guardan: siempre van en vivo.
 */
var CACHE = 'robot3c-v2';
var ARCHIVOS = ['./', './index.html', './config.js', './manifest.json', './icono-192.png', './icono-512.png', './logo-jc-blanco.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ARCHIVOS); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // todo lo que no sea esta misma página (servidor, Google) pasa de largo
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      var copia = r.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copia); }).catch(function () {});
      return r;
    }).catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match('./index.html'); }); })
  );
});
