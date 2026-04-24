const APP_CACHE = 'aac-converter-app-v1'
const FFMPEG_CACHE = 'aac-converter-ffmpeg-core-v1'

const BASE_PATH = '/Float32bit-AAC_LC-converter-pwa/'

const APP_SHELL = [
  BASE_PATH,
  `${BASE_PATH}index.html`,
  `${BASE_PATH}manifest.webmanifest`,
  `${BASE_PATH}favicon.svg`,
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => ![APP_CACHE, FFMPEG_CACHE].includes(name))
          .map((name) => caches.delete(name))
      )
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // ffmpeg-core.js / ffmpeg-core.wasm をキャッシュ
  if (
    url.hostname === 'cdn.jsdelivr.net' &&
    url.pathname.includes('/npm/@ffmpeg/core@') &&
    (
      url.pathname.endsWith('/ffmpeg-core.js') ||
      url.pathname.endsWith('/ffmpeg-core.wasm')
    )
  ) {
    event.respondWith(cacheFirst(request, FFMPEG_CACHE))
    return
  }

  // GitHub Pages配下のアプリ本体・assets をキャッシュ
  if (url.origin === self.location.origin && url.pathname.startsWith(BASE_PATH)) {
    event.respondWith(staleWhileRevalidate(request, APP_CACHE))
  }
})

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)

  if (cached) return cached

  const response = await fetch(request)

  if (response && response.ok) {
    cache.put(request, response.clone())
  }

  return response
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => cached)

  return cached || fetchPromise
}