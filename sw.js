// ═══════════════════════════════════════════════════════════════
//  LexiPyramide — Service Worker  v2.0
//  Stratégies :
//    • Solo  → Cache-First + IndexedDB → jouable 100% hors ligne
//    • Multi → Network-Only (Firebase nécessite la connexion)
//    • Assets statiques → Cache-First avec revalidation
//    • Fonts / CDN → Stale-While-Revalidate
//    • Background Sync → synchronise les scores solo quand on revient en ligne
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME      = 'lexipyramide-v2';
const OFFLINE_PAGE    = '/offline.html';

// ── Ressources à pré-cacher au moment de l'installation ──────
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/site.webmanifest',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/apple-touch-icon.png',
  // Fonts Google (mise en cache pour offline)
  'https://fonts.googleapis.com/css2?family=Exo+2:wght@400;600;700;800;900&family=Orbitron:wght@700;900&display=swap',
];

// ── Domaines qui ne doivent JAMAIS passer par le cache ───────
//    (Firebase Realtime DB, Firebase Auth, Analytics)
const NETWORK_ONLY_PATTERNS = [
  /firebaseio\.com/,
  /firebase\.com/,
  /firebasestorage\.app/,
  /googleapis\.com\/identitytoolkit/,
  /google-analytics\.com/,
];

// ── Domaines à mettre en cache (Stale-While-Revalidate) ──────
const SWR_PATTERNS = [
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
];

// ════════════════════════════════════════════════════════════════
//  INSTALL — Pré-cache des ressources essentielles
// ════════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log('[SW] Installation v2');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // On met en cache ce qu'on peut ; les erreurs n'interrompent pas l'install
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Précache échoué pour ${url}:`, err)
          )
        )
      );
    }).then(() => {
      console.log('[SW] Précache terminé');
      return self.skipWaiting(); // Activation immédiate
    })
  );
});

// ════════════════════════════════════════════════════════════════
//  ACTIVATE — Nettoyage des anciens caches
// ════════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log('[SW] Activation v2');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log(`[SW] Suppression ancien cache : ${key}`);
            return caches.delete(key);
          })
      )
    ).then(() => {
      console.log('[SW] Clients pris en charge immédiatement');
      return self.clients.claim();
    })
  );
});

// ════════════════════════════════════════════════════════════════
//  FETCH — Stratégies de routage
// ════════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── 1. Network-Only : Firebase & APIs temps réel ─────────────
  if (NETWORK_ONLY_PATTERNS.some(p => p.test(request.url))) {
    event.respondWith(
      fetch(request).catch(() => {
        // Si offline, retourner une réponse JSON d'erreur propre
        if (request.headers.get('accept')?.includes('application/json')) {
          return new Response(
            JSON.stringify({ error: 'offline', message: 'Connexion requise pour le mode multijoueur.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('', { status: 503 });
      })
    );
    return;
  }

  // ── 2. Stale-While-Revalidate : Fonts & CDN ──────────────────
  if (SWR_PATTERNS.some(p => p.test(request.url))) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // ── 3. POST/PUT/DELETE → Network-Only ────────────────────────
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // ── 4. Cache-First avec fallback réseau pour tout le reste ───
  event.respondWith(cacheFirstWithNetworkFallback(request));
});

// ════════════════════════════════════════════════════════════════
//  Stratégie : Cache-First → Network → Offline page
// ════════════════════════════════════════════════════════════════
async function cacheFirstWithNetworkFallback(request) {
  const cache = await caches.open(CACHE_NAME);

  // Essai cache
  const cached = await cache.match(request);
  if (cached) return cached;

  // Essai réseau
  try {
    const networkResponse = await fetch(request);
    // On met en cache les réponses valides (pas les 4xx/5xx)
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Hors ligne — retourner la page offline pour les navigations HTML
    if (request.destination === 'document') {
      const offlinePage = await cache.match(OFFLINE_PAGE);
      if (offlinePage) return offlinePage;
    }
    return new Response('', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ════════════════════════════════════════════════════════════════
//  Stratégie : Stale-While-Revalidate
// ════════════════════════════════════════════════════════════════
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Mettre à jour en arrière-plan
  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await networkFetch || new Response('', { status: 503 });
}

// ════════════════════════════════════════════════════════════════
//  BACKGROUND SYNC — Synchronisation scores solo quand online
// ════════════════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  console.log('[SW] Background Sync déclenché :', event.tag);

  if (event.tag === 'sync-solo-scores') {
    event.waitUntil(syncSoloScores());
  }
  if (event.tag === 'sync-solo-progress') {
    event.waitUntil(syncSoloProgress());
  }
});

async function syncSoloScores() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_SOLO_SCORES' });
    });
    console.log('[SW] Message SYNC_SOLO_SCORES envoyé aux clients');
  } catch (err) {
    console.error('[SW] Erreur syncSoloScores:', err);
  }
}

async function syncSoloProgress() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_SOLO_PROGRESS' });
    });
    console.log('[SW] Message SYNC_SOLO_PROGRESS envoyé aux clients');
  } catch (err) {
    console.error('[SW] Erreur syncSoloProgress:', err);
  }
}

// ════════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS (prêt à l'emploi)
// ════════════════════════════════════════════════════════════════
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body || 'Nouvelle notification LexiPyramide',
    icon: '/favicon-32x32.png',
    badge: '/favicon-16x16.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: '🎮 Jouer' },
      { action: 'close', title: 'Fermer' }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'LexiPyramide ◆', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'open' || !event.action) {
    event.waitUntil(
      clients.openWindow(event.notification.data?.url || '/')
    );
  }
});

// ════════════════════════════════════════════════════════════════
//  MESSAGES depuis le client principal
// ════════════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  const { type } = event.data || {};

  // Forcer la mise à jour du SW
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Vider le cache (utile pour le debug ou les mises à jour forcées)
  if (type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    });
  }

  // Précharger des URLs supplémentaires
  if (type === 'PRECACHE_URLS' && Array.isArray(event.data.urls)) {
    caches.open(CACHE_NAME).then(cache => {
      cache.addAll(event.data.urls);
    });
  }
});

console.log('[SW] LexiPyramide Service Worker v2 chargé ✅');
