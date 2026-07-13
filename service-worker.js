// ============================================================
// SQC Service Worker — 快取 App 殼層，讓離線也能開啟
//   - 本站靜態檔：cache-first（離線可用）
//   - GAS API / Drive：一律走網路，不快取（資料要即時）
// ============================================================
const CACHE = 'sqc-shell-v2';
const SHELL = [
  './',
  './index.html',
  './app.html',
  './manifest.json',
  './icon.svg',
  './js/config.js',
  './js/api.js',
  './js/db.js',
  './js/uploader.js',
  // 外部 CDN（opaque 快取，離線可用）
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  // API 與 Drive：永遠走網路（不快取）
  if (e.request.method !== 'GET' || url.includes('script.google.com') || url.includes('googleapis.com') || url.includes('script.googleusercontent.com')) {
    return; // 交給瀏覽器預設處理
  }
  // 靜態資源：network-first（有網路一定拿最新、更新後即時生效；離線才用快取）
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
