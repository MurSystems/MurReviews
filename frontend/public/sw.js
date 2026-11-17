// Minimal service worker: the app is served from the network. Its presence is
// what lets Chrome offer "Install app" when the manifest is valid.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Network passthrough. Nothing is cached, so a deploy is seen immediately.
});
