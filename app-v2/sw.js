const CACHE_NAME = "vani-fede-static-v32448";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=32448",
  "./app.js?v=32448",
  "./config.js",
  "./manifest.webmanifest",
  "./assets/branding/vyf-seal.png?v=32448",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Google Apps Script, fuentes y servicios externos nunca se cachean acá.
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });
        }
        return response;
      })
      .catch(async () => {
        const exact = await caches.match(request);
        if (exact) return exact;

        if (request.mode === "navigate") {
          return (
            (await caches.match("./index.html")) ||
            (await caches.match("./"))
          );
        }

        return Response.error();
      })
  );
});
