/* MitoForge app shell.
   Bump CACHE when the shell should drop previously cached files.
   index.html is network-first, so an online visit still picks up a new page
   before this file itself changes.
   Third-party and API requests are never intercepted or stored. */
const CACHE = "mitoforge-shell-v11";

const API_HOSTS = new Set([
  "api.anthropic.com",
  "api.x.ai",
  "api.openai.com",
  "script.google.com",
  "script.googleusercontent.com",
]);

const SHELL = [
  "./manifest.webmanifest",
  "./drive-sync/sync-client.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

function abs(path) {
  return new URL(path, self.location).href;
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const indexRes = await fetch(abs("./index.html"), { cache: "reload" });
      if (!indexRes.ok) throw new Error("Could not precache index.html");
      const indexBody = await indexRes.arrayBuffer();
      const indexType = indexRes.headers.get("Content-Type") || "text/html; charset=utf-8";
      const shellDoc = () => new Response(indexBody.slice(0), {
        status: 200,
        headers: { "Content-Type": indexType },
      });
      await cache.put(abs("./index.html"), shellDoc());
      await cache.put(abs("./"), shellDoc());
      await cache.addAll(SHELL.map(abs));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

function isBlocked(url) {
  if (API_HOSTS.has(url.hostname)) return true;
  if (url.origin !== self.location.origin) return true;
  return false;
}

function isDocument(request, url) {
  if (request.mode === "navigate" || request.destination === "document") return true;
  return url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");
}

async function store(cache, request, response) {
  try {
    if (!response || !response.ok || response.type !== "basic") return;
    const headers = new Headers();
    const type = response.headers.get("Content-Type");
    if (type) headers.set("Content-Type", type);
    const body = await response.arrayBuffer();
    await cache.put(request, new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }));
  } catch (err) {
    /* A cache write must not fail the navigation. */
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type === "basic") {
      await store(cache, request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(abs("./index.html"))) ||
      (await cache.match(abs("./")));
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === "basic") {
        return store(cache, request, response.clone()).then(() => response);
      }
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const response = await refresh;
  if (response) return response;
  return new Response("", { status: 504, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /* Never cache or intercept provider APIs or any other third-party request. */
  if (isBlocked(url)) return;

  if (isDocument(request, url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
