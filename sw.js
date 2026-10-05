// オフライン用のサービスワーカー。
//
// 自分のファイルは network-first（つながっていれば常に最新、圏外なら保存しておいた版）。
// Google Fonts は変わらないので cache-first。
//
// 注意: キャッシュ（CacheStorage）は t-of.github.io のすべてのアプリで共有されている。
// 古いキャッシュを消すときは、必ず自分の PREFIX で始まるものだけを消す。
// keys.filter(k => k !== CACHE) のように書くと、ほかのアプリのキャッシュまで消してしまう。
// ブラウザの HTTP キャッシュを通さない（install は reload、fetch は no-cache）。古い main.js と新しい index.html が混ざって動かなくなるのを防ぐ。

// 注意: PREFIX は 'catan3d-'（ハイフンなし）。'catan-3d-' にすると元の catan アプリの
// PREFIX 'catan-' の前方一致に引っかかり(''catan-3d-v1'.startsWith('catan-')===true)、
// catan 側の activate が catan-3d のキャッシュまで消してしまう。それを避けるための名前。
const PREFIX = 'catan3d-';
const VERSION = 'v6';
const CACHE = `${PREFIX}${VERSION}`;
const FONT_CACHE = `${PREFIX}fonts`;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './engine.js',
  './cpu.js',
  './illust.js',
  './online.js',
  './room.js',
  './qr.js',
  './board3d.js',
  './vendor/three.module.min.js',
  './vendor/OrbitControls.js',
  './vendor/RoomEnvironment.js',
  './vendor/RGBELoader.js',
  './textures/forest_diff.jpg',
  './textures/forest_nor.jpg',
  './textures/forest_arm.jpg',
  './textures/pasture_diff.jpg',
  './textures/pasture_nor.jpg',
  './textures/pasture_arm.jpg',
  './textures/field_diff.jpg',
  './textures/field_nor.jpg',
  './textures/field_arm.jpg',
  './textures/hills_diff.jpg',
  './textures/hills_nor.jpg',
  './textures/hills_arm.jpg',
  './textures/mountains_diff.jpg',
  './textures/mountains_nor.jpg',
  './textures/mountains_arm.jpg',
  './textures/desert_diff.jpg',
  './textures/desert_nor.jpg',
  './textures/desert_arm.jpg',
  './textures/sky.hdr',
  './manifest.webmanifest',
  './webapp-kit/webapp-kit.css',
  './webapp-kit/webapp-kit.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './sounds/win.mp3',
  './sounds/build.mp3',
  './sounds/trade.mp3',
  './sounds/myTurn.mp3',
  './sounds/tradeOffered.mp3',
  './sounds/cutin.mp3',
  './sounds/wave.mp3',
  './sounds/bgm-title.mp3',
  './sounds/bgm-game.mp3',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith(PREFIX) && k !== CACHE && k !== FONT_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(networkFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONT_CACHE));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || Response.error();
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
