// Herria: permite instalar la app. Todo se carga siempre desde internet,
// y la página principal siempre se revisa para que los cambios lleguen al momento.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const fresh = req.mode === 'navigate' || /\/(index\.html)?$|manifest\.json$|sw\.js$/.test(new URL(req.url).pathname);
  e.respondWith(fresh ? fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)) : fetch(req));
});
