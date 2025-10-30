// Caledon Transit PWA - Safe Service Worker
// Version 2.0

const CACHE_NAME = 'caledon-transit-v3';
const IS_LOCAL =
  self.location.hostname === '127.0.0.1' ||
  self.location.hostname === 'localhost';

// Install event - cache essential assets only in production
self.addEventListener('install', event => {
  if (IS_LOCAL) {
    console.log('⚙️ Service Worker: Skipping install in Live Preview / Local Dev');
    return;
  }

  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      const assetsToCache = [
        '/', '/index.html', '/manifest.json', '/favicon.png',
        '/caledon.png', '/psd.png', '/ad (1).png', '/plantrip.png',
        '/New Project (6).png', '/cust.png', '/location.png', '/New Project (8).png',
        '/icons/icon-192x192.png', '/icons/icon-512x512.png',
        '/stops.txt', '/stop_times.txt', '/trips.txt', '/calendar.txt', '/shapes.txt',
        // External styles & libraries
        'https://cdn.jsdelivr.net/npm/remixicon@3.2.0/fonts/remixicon.css',
        'https://unpkg.com/boxicons@latest/css/boxicons.min.css',
        'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600&display=swap',
        'https://fonts.googleapis.com/css2?family=Rubik:wght@500&display=swap',
        'https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&display=swap',
        'https://api.tomtom.com/maps-sdk-for-web/cdn/6.x/6.15.0/maps/maps.css',
        'https://api.tomtom.com/maps-sdk-for-web/cdn/6.x/6.15.0/maps/maps-web.min.js'
      ];

      try {
        await cache.addAll(assetsToCache);
        console.log('✅ Service Worker: Cached all assets');
      } catch (err) {
        console.warn('⚠️ Some assets failed to cache:', err);
      }
    })
  );

  self.skipWaiting();
});

// Activate event - clean old caches & auto-refresh tabs
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => key !== CACHE_NAME && caches.delete(key)))
    )
  );

  self.clients.claim();

  // 🔄 Auto-refresh open tabs when a new service worker activates
  self.clients.matchAll({ type: 'window' }).then(clients => {
    for (const client of clients) {
      client.navigate(client.url);
    }
  });

  console.log('🚀 Service Worker: Activated and ready');
});

// Fetch event - cache-first only in production
// Fetch event – serve only pre-cached assets
self.addEventListener('fetch', event => {
  if (IS_LOCAL) return;
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then(cachedRes => {
      if (cachedRes) return cachedRes;
      return fetch(req).catch(() => {
        if (req.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
