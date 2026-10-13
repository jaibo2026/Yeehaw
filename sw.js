// Ranchfolk: permite instalar la app. Todo se carga siempre desde internet,
// y la página principal siempre se revisa para que los cambios lleguen al momento.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Caché de fotos y videos: los archivos de Supabase nunca cambian (cada uno tiene su nombre único),
// así que lo que ya se vio se sirve desde el teléfono y no vuelve a gastar datos.
const IMG_CACHE = 'rf-img-v1', VID_CACHE = 'rf-vid-v1';
const MEDIA_RE = /\/storage\/v1\/object\/public\/media\//;
const MAX_IMG = 250, MAX_VID = 25, MAX_VID_BYTES = 40 * 1048576;
async function trim(name, max) {
  try { const c = await caches.open(name); const keys = await c.keys(); for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]); } catch (_) {}
}
function isVideoUrl(u) { return /\.(mp4|webm|mov|m4v|3gp)(\?|$)/i.test(u); }
async function fromCache(name, url) { try { const c = await caches.open(name); return await c.match(url); } catch (_) { return null; } }
// Los videos se piden "en pedacitos" (Range); se arma el pedacito desde el video guardado
async function sliced(res, range) {
  const blob = await res.blob();
  const size = blob.size;
  const m = /bytes=(\d*)-(\d*)/.exec(range || '') || [];
  let start = m[1] ? Number(m[1]) : 0, end = m[2] ? Number(m[2]) : size - 1;
  if (!m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  end = Math.min(end, size - 1);
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': res.headers.get('Content-Type') || 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}
async function mediaFetch(req) {
  const url = req.url;
  if (isVideoUrl(url)) {
    const hit = await fromCache(VID_CACHE, url);
    if (hit) { const r = req.headers.get('range'); return r ? sliced(hit, r) : hit; }
    return fetch(req);
  }
  const hit = await fromCache(IMG_CACHE, url);
  if (hit) return hit;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(IMG_CACHE).then(c => c.put(url, copy)).then(() => trim(IMG_CACHE, MAX_IMG)).catch(() => {}); }
    return res;
  } catch (_) { return fetch(req); }
}
// La app avisa cuando ya viste un video casi completo; entonces se guarda en el teléfono
async function keepVideo(url) {
  if (!MEDIA_RE.test(url) || !isVideoUrl(url)) return;
  const c = await caches.open(VID_CACHE);
  if (await c.match(url)) return;
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok || res.status !== 200) return;
  const len = Number(res.headers.get('Content-Length') || 0);
  if (len > MAX_VID_BYTES) return;
  await c.put(url, res);
  await trim(VID_CACHE, MAX_VID);
}
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'rf-keep' && d.url) e.waitUntil(keepVideo(d.url).catch(() => {}));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (MEDIA_RE.test(req.url)) return e.respondWith(mediaFetch(req).catch(() => fetch(req)));
  const fresh = req.mode === 'navigate' || /\/(index\.html)?$|manifest\.json$|sw\.js$/.test(new URL(req.url).pathname);
  e.respondWith(fresh ? fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)) : fetch(req));
});

// Avisos en el teléfono: mensajes, reacciones, comentarios y seguidores, aunque Ranchfolk esté cerrada
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.some(w => w.visibilityState === 'visible');
    // Con la app abierta: le avisamos a la app para que suene la campana adentro
    const isChat = String(d.tag || '').startsWith('chat-');
    wins.forEach(w => { if (w.visibilityState === 'visible') { try { w.postMessage({ type: isChat ? 'herria-msg' : 'herria-notif', tag: d.tag || '' }); } catch (_) {} } });
    await self.registration.showNotification(d.title || 'Ranchfolk', {
      body: d.body || 'Tienes un mensaje nuevo',
      icon: 'icon-maskable-192.png',
      badge: 'icon-192.png',
      tag: d.tag || 'herria',
      renotify: true,
      silent: open,
      vibrate: [120, 60, 120],
      data: { url: d.url || './' },
      actions: isChat ? [{ action: 'reply', title: '💬 Responder' }] : [],
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
