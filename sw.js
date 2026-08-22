// 로그인 화면 배경 영상(day.mp4/night.mp4) 캐싱 전용 서비스 워커.
// 최초 1회만 다운로드하고, 이후 재방문·홈 화면 추가(PWA) 시 캐시에서 즉시 재생한다.

const CACHE_NAME = 'isa-rebalancer-video-v1';
const VIDEO_PATHS = ['/assets/day.mp4', '/assets/night.mp4'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(VIDEO_PATHS); })
      .catch(function () { /* 설치 시점 네트워크 문제는 무시 — fetch 시 재시도됨 */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (VIDEO_PATHS.indexOf(url.pathname) === -1) return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        return res;
      });
    })
  );
});
