const CORE_CACHE = 'slovakia-guide-core-v9';
const TRAIL_CACHE = 'slovakia-guide-trails-v3';
const CORE_URLS = [
  './', './guide.html', './trail-days.json', './day-plan-overrides.json',
  './aug31-lomnica.gpx', './sep1-hrebienok.gpx', './sep2-strbske-popradske.gpx',
  './sep3-sucha-bela.gpx', './sep4-bachledka-cave.gpx',
];

async function getDayPlanOverrides() {
  try {
    const network = await fetch('./day-plan-overrides.json', { cache: 'no-store' });
    if (network.ok) {
      const cache = await caches.open(CORE_CACHE);
      await cache.put('./day-plan-overrides.json', network.clone());
      return await network.json();
    }
  } catch (error) {
    // Fall back to cache below.
  }
  const cached = await caches.match('./day-plan-overrides.json');
  if (!cached) return { replacements: [] };
  try {
    return await cached.json();
  } catch (error) {
    return { replacements: [] };
  }
}

async function applyDayPlanOverrides(response) {
  if (!response) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  const overrides = await getDayPlanOverrides();
  for (const item of overrides.replacements || []) {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') continue;
    html = html.split(item.from).join(item.to);
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await Promise.allSettled(CORE_URLS.map(async url => {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, TRAIL_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(name => !keep.has(name)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.hostname === 'outdoor.tiles.freemap.sk') {
    event.respondWith((async () => {
      const cache = await caches.open(TRAIL_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      await cache.put(event.request, response.clone());
      return response;
    })());
    return;
  }

  if (url.origin === self.location.origin && event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(event.request, { cache: 'no-store' });
        const transformed = await applyDayPlanOverrides(networkResponse.clone());
        const cache = await caches.open(CORE_CACHE);
        await cache.put(event.request, transformed.clone());
        return transformed;
      } catch (error) {
        const cached = (await caches.match(event.request)) || (await caches.match('./guide.html'));
        return await applyDayPlanOverrides(cached);
      }
    })());
  }
});

self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'CACHE_TRAIL_MAP') return;
  const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
  const dayId = event.data.dayId;
  event.waitUntil((async () => {
    const cache = await caches.open(TRAIL_CACHE);
    let done = 0;
    let failed = 0;
    for (let offset = 0; offset < urls.length; offset += 12) {
      const batch = urls.slice(offset, offset + 12);
      const results = await Promise.allSettled(batch.map(async url => {
        if (!(await cache.match(url))) {
          const response = await fetch(url, { mode: 'no-cors' });
          await cache.put(url, response);
        }
      }));
      failed += results.filter(result => result.status === 'rejected').length;
      done += batch.length;
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach(client => client.postMessage({ type: 'TRAIL_CACHE_STATUS', dayId, done, total: urls.length, failed, complete: done === urls.length && failed === 0 }));
    }
  })());
});
