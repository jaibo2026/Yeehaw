// Ranchfolk: permite instalar la app. Todo se carga siempre desde internet,
// y la página principal siempre se revisa para que los cambios lleguen al momento.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const fresh = req.mode === 'navigate' || /\/(index\.html)?$|manifest\.json$|sw\.js$/.test(new URL(req.url).pathname);
  e.respondWith(fresh ? fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)) : fetch(req));
});

// Avisos en el teléfono: llega un mensaje aunque Ranchfolk esté cerrada
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.some(w => w.visibilityState === 'visible');
    // Con la app abierta: le avisamos a la app para que suene la campana adentro
    wins.forEach(w => { if (w.visibilityState === 'visible') { try { w.postMessage({ type: 'herria-msg', tag: d.tag || '' }); } catch (_) {} } });
    await self.registration.showNotification(d.title || 'Ranchfolk', {
      body: d.body || 'Tienes un mensaje nuevo',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.tag || 'herria',
      renotify: true,
      silent: open,
      vibrate: [120, 60, 120],
      data: { url: d.url || './' },
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); try { await w.navigate(url); } catch (_) {} return; }
    }
    await self.clients.openWindow(url);
  })());
});
