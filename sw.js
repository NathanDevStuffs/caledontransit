const CACHE_NAME = 'caledon-transit-v1';

// During install, pre-cache all known files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const assetsToCache = [
        '/', '/index.html', '/manifest.json', '/favicon.png',
        '/caledon.png', '/psd.png', '/ad (1).png', '/plantrip.png',
        '/New Project (6).png', '/cust.png', '/location.png', '/New Project (8).png',
        '/icons/icon-192x192.png', '/icons/icon-512x512.png',
        '/stops.txt', '/stop_times.txt', '/trips.txt', '/calendar.txt', '/shapes.txt',
        // Fonts and styles
        'https://cdn.jsdelivr.net/npm/remixicon@3.2.0/fonts/remixicon.css',
        'https://unpkg.com/boxicons@latest/css/boxicons.min.css',
        'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600&display=swap',
        'https://fonts.googleapis.com/css2?family=Rubik:wght@500&display=swap',
        'https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&display=swap',
        'https://api.tomtom.com/maps-sdk-for-web/cdn/6.x/6.15.0/maps/maps.css',
        'https://api.tomtom.com/maps-sdk-for-web/cdn/6.x/6.15.0/maps/maps-web.min.js'
      ];

      // Try to fetch and cache all assets
      try {
        await cache.addAll(assetsToCache);
        console.log('Service Worker: Cached all assets');
      } catch (err) {
        console.warn('⚠️ Some assets failed to cache:', err);
      }
    })
  );
  self.skipWaiting();
});

// Delete old caches on activation
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => key !== CACHE_NAME && caches.delete(key)))
    )
  );
  self.clients.claim();
  console.log('Service Worker: Activated');
});

// Intercept fetch requests
self.addEventListener('fetch', event => {
  const req = event.request;

  // Skip non-GET requests (like analytics, ads, etc.)
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then(cachedRes => {
      if (cachedRes) return cachedRes; // return from cache if found

      return fetch(req)
        .then(networkRes => {
          // Cache the fetched file dynamically
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(req, networkRes.clone());
            return networkRes;
          });
        })
        .catch(() => {
          // If offline and not cached
          if (req.destination === 'document') {
            return caches.match('/index.html');
          }
        });
    })
  );
});
