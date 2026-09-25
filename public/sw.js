self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// CRM is live data -- always go to network, never serve stale API responses.
// FIX: API calls and cross-origin requests are left to the browser, and when
// the network fails with nothing cached we return a proper error Response
// (the old code returned `undefined` -> "Failed to convert value to 'Response'").
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req).catch(async () => {
      const cached = await caches.match(req);
      return cached || Response.error();
    })
  );
});
