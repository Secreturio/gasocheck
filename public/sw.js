// Modo sin conexión: guarda la app y los últimos precios descargados.
// Cambia VERSION al publicar cambios para renovar la caché.
const VERSION = 'gasocheck-v30';
const APP = ['./', 'index.html', 'styles.css', 'app.js', 'graficas.js', 'horario.js', 'micoche.js', 'coches.js', 'editor-imagen.js', 'cuenta.js', 'ojo.js', 'legal.js', 'ruta.js', 'gps.js', 'ticket.js', 'avisos.js', 'fotos.js', 'config.js', 'img/logo.png', 'img/favoritos-vacio.jpg', 'img/gasolinera.jpg', 'img/icon-192.png', 'img/favicon-32.png', 'manifest.webmanifest', 'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet.markercluster.js', 'vendor/MarkerCluster.css'];
const CDN = /^https:\/\/(unpkg\.com|fonts\.(googleapis|gstatic)\.com)\//;
const GUARDAR_API = ['/api/estaciones', '/api/calidad', '/api/variaciones', '/api/problemas'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Primero la red; si falla, lo guardado
async function redPrimero(req) {
  const cache = await caches.open(VERSION);
  try {
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch (err) {
    const guardado = await cache.match(req, { ignoreSearch: false });
    if (guardado) return guardado;
    throw err;
  }
}

// Librerías y fuentes: lo guardado primero (no cambian)
async function cachePrimero(req) {
  const cache = await caches.open(VERSION);
  const guardado = await cache.match(req);
  if (guardado) return guardado;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') cache.put(req, r.clone());
  return r;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN.test(req.url)) return e.respondWith(cachePrimero(req));
  if (url.origin !== self.location.origin) return; // mosaicos del mapa: directos
  if (url.pathname.startsWith('/api/')) {
    if (GUARDAR_API.includes(url.pathname)) return e.respondWith(redPrimero(req));
    return; // historial y valoraciones: solo con conexión
  }
  e.respondWith(redPrimero(req));
});

// ---- Notificaciones push ----
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { texto: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.titulo || 'GasoCheck', {
      body: d.texto || '',
      icon: 'img/icon-192.png',
      badge: 'img/favicon-48.png',
      tag: d.tipo ? `gasocheck-${d.tipo}-${d.url || ''}` : undefined,
      data: { url: d.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  const estacion = (url.match(/#e(\w+)$/) || [])[1];
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      const abierta = ventanas.find((v) => v.url.startsWith(self.registration.scope));
      if (abierta) {
        abierta.postMessage({ tipo: 'abrir', estacion });
        return abierta.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
