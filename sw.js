// Service worker d'Aveuglator 2000. Deux rôles :
//
// 1. Isolation « cross-origin » : GitHub Pages ne permet pas de régler les en-têtes HTTP, or le
//    calcul WebAssembly multi-fil (trois à quatre fois plus rapide) exige les en-têtes COOP et
//    COEP. Ils sont ajoutés ici à chaque réponse.
// 2. Cache : le modèle et le moteur d'inférence (gros, immuables) sont servis depuis le cache ;
//    le reste du site passe par le réseau et retombe sur le cache hors connexion.

const SHELL_CACHE = 'aveuglator-shell-v1';
const ASSET_CACHE = 'aveuglator-assets-v1';
const HEAVY_ASSET = /\/(models|vendor)\//;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('aveuglator-') && name !== SHELL_CACHE && name !== ASSET_CACHE)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const strategy = HEAVY_ASSET.test(url.pathname) ? cacheFirst : networkFirst;
  event.respondWith(strategy(request).then(isolate));
});

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  // Les paramètres d'adresse ne servent qu'à obtenir une copie neuve d'un module : même fichier.
  const cached = await cache.match(request.url, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request.url);
  if (response.status === 200) {
    cache.put(request.url, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // « no-cache » : revalide auprès du serveur, pour qu'une mise à jour du site soit visible aussitôt.
    const response = await fetch(request.url, { cache: 'no-cache' });
    if (response.status === 200) {
      cache.put(request.url, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request.url);
    if (cached) return cached;
    throw error;
  }
}

/** Renvoie la même réponse, enrichie des en-têtes qui rendent la page « cross-origin isolated ». */
function isolate(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
