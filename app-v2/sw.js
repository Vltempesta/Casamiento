const CACHE_NAME = "vani-fede-static-v32455";

const APP_SHELL = [
  "./index.html",
  "./styles.css?v=32455",
  "./app.js?v=32455",
  "./config.js?v=32455",
  "./manifest.webmanifest?v=32455",
  "./assets/branding/vyf-seal.png?v=32455",
  "./icons/icon-32.png",
  "./icons/icon-48.png",
  "./icons/icon-96.png",
  "./icons/icon-128.png",
  "./icons/icon-192.png",
  "./icons/icon-256.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.ico"
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

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // version.json siempre se consulta en la red.
  if (
    url.origin === self.location.origin &&
    url.pathname.endsWith("/version.json")
  ) {
    event.respondWith(
      fetch(
        new Request(request, { cache: "no-store" })
      )
    );
    return;
  }

  // Apps Script, fuentes y servicios externos no se cachean acá.
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(request));
    return;
  }

  const freshRequest = new Request(
    request,
    { cache: "no-store" }
  );

  event.respondWith(
    fetch(freshRequest)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            if (request.mode === "navigate") {
              cache.put("./index.html", copy);
            } else {
              cache.put(request, copy);
            }
          });
        }

        return response;
      })
      .catch(async () => {
        if (request.mode === "navigate") {
          return (
            (await caches.match("./index.html")) ||
            Response.error()
          );
        }

        return (
          (await caches.match(request)) ||
          Response.error()
        );
      })
  );
});
