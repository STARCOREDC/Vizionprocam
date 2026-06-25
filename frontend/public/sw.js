// Service Worker do PWA VizionPro (painel admin).
// Estratégia: network-first com fallback de cache pro "app shell" — nunca
// interfere em API/streams (sempre rede direta), pra não quebrar dados ao vivo.
const CACHE = 'vizionpro-pwa-v2'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  // limpa caches antigos de versões anteriores
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // só GET e só mesma origem; API, streams e gravações passam DIRETO (sem cache)
  if (
    e.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/hls') ||
    url.pathname.startsWith('/playback')
  ) {
    return
  }
  // app shell: tenta a rede, cacheia, e cai no cache se estiver offline
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {})
        return res
      })
      .catch(() =>
        caches.match(e.request).then((r) => r || caches.match('/'))
      )
  )
})
