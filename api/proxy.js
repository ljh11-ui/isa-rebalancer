// Vercel 서버 함수 — 브라우저 대신 Apps Script를 호출해준다.
// 브라우저는 같은 사이트(/api/proxy)만 부르므로 CORS가 아예 적용되지 않는다.

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycby4yW8EZymTsSWcmesbVHlFIYqotJHxDwiPoTc1ZxcMkzMTtJIQoCGvil-bA9gR4h-1Rw/exec';

export default async function handler(req, res) {
  try {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) {
      params.append(k, Array.isArray(v) ? v[0] : v);
    }

    const upstream = await fetch(APPS_SCRIPT_URL + '?' + params.toString(), {
      redirect: 'follow',
    });
    const text = await upstream.text();

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    // Apps Script가 오류 페이지(HTML)를 돌려주는 경우를 걸러낸다
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return res.status(200).send(
        JSON.stringify({ error: 'Apps Script가 예상치 못한 응답을 보냈습니다. 배포 설정을 확인해주세요.' })
      );
    }
    return res.status(200).send(text);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ error: '서버 연결 실패: ' + String(e && e.message || e) }));
  }
}
