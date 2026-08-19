/**
 * 5분할 리밸런싱 포트폴리오 — API 전용 (화면은 Vercel에서 그림)
 * 규칙: 상단 초과분만 매도 → 목표 대비 부족분 비례 배분. 하단 밴드 없음.
 *
 * 배포: 실행 = 나 / 액세스 = 모든 사용자 → /exec 주소 사용
 */

const SHEET_ID = '1vjteD7fGeJqRJwv4Xx6MwYgdnT6JbCl2ZSRQmj6ERfA';
const N = 5;

// UserData 열 번호 (1-based)
const C_CASH = 3, C_DEP = 4, C_SHARES = 5, C_CUM = 10,
      C_PEAK = 11, C_PEAKCUM = 12, C_BELOW = 13, C_LAST = 17;

// 해외 티커 → GOOGLEFINANCE 표기 (거래소 접두어가 종목마다 다름)
const OV_TICKER = {
  QQQ: 'NASDAQ:QQQ', SPMO: 'NYSEARCA:SPMO', SCHD: 'NYSEARCA:SCHD',
  DGRW: 'NASDAQ:DGRW', SGOV: 'SGOV'
};

// 화면 표시용 짧은 이름 (로그·AUM 목록에서 사용)
const SHORT_NAME = {
  '133690': '나스닥',      'QQQ':  '나스닥',
  '0137V0': 'S&P500',     'SPMO': 'S&P500',
  '458730': '슈드',        'SCHD': '슈드',
  '0046Y0': '배당퀄리티',   'DGRW': '배당퀄리티',
  '456610': '미국 초단기채', 'SGOV': '미국 초단기채'
};

// 국내 종목코드 → 대응하는 미국 직투 티커 (표에서 풀네임 아래 작게 표시)
const US_TICKER = {
  '133690': 'QQQ',  'QQQ':  'QQQ',
  '0137V0': 'SPMO', 'SPMO': 'SPMO',
  '458730': 'SCHD', 'SCHD': 'SCHD',
  '0046Y0': 'DGRW', 'DGRW': 'DGRW',
  '456610': 'SGOV', 'SGOV': 'SGOV'
};

function shortName_(code) {
  const c = String(code).trim();
  return SHORT_NAME[c] || SHORT_NAME[c.toUpperCase()] || '';
}

function usTicker_(code) {
  const c = String(code).trim();
  return US_TICKER[c] || US_TICKER[c.toUpperCase()] || '';
}

// ===== 라우터 =====
function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    switch (p.action) {
      case 'login':  out = login(p.user, p.pw); break;
      case 'signup': out = signUp(p.user, p.pw); break;
      case 'load':   out = loadState(p.user, p.market); break;
      case 'calc':   out = calcOnly(p.user, p.market, p.cash, p.dep, p.shares); break;
      case 'save':   out = saveState(p.user, p.market, p.cash, p.dep, p.shares); break;
      case 'logs':   out = getRecentLogs(p.user, p.market); break;
      case 'aum':    out = getAumInfo(p.market); break;
      case 'ret':    out = getReturnOne(p.market, Number(p.index)); break;
      default:       out = { error: '알 수 없는 요청입니다: ' + p.action };
    }
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  const body = JSON.stringify(out);
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 시트 접근 =====
function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function usersSheet_() { return ss_().getSheetByName('Users'); }
function udSheet_() { return ss_().getSheetByName('UserData'); }
function assetSheet_(market) {
  return market === 'overseas' ? ss_().getSheetByName('Overseas') : ss_().getSheets()[0];
}
function ticker_(market, code) {
  const c = String(code).trim();
  return market === 'overseas' ? (OV_TICKER[c.toUpperCase()] || c) : 'KRX:' + c;
}
function mk_(m) { return m === 'overseas' ? 'overseas' : 'domestic'; }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }

function tmpSheet_() {
  const ss = ss_();
  let t = ss.getSheetByName('_tmpQuote');
  if (!t) { t = ss.insertSheet('_tmpQuote'); t.hideSheet(); }
  return t;
}

// 시트에서 읽은 날짜값을 안전하게 yyyy-MM-dd 문자열로
function toDateStr_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

function daysBetween_(from, to) {
  const a = new Date(from + 'T00:00:00+09:00'), b = new Date(to + 'T00:00:00+09:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// ===== 계정 =====
function hashPw_(pw) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pw), Utilities.Charset.UTF_8)
    .map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
}

function findUserRow_(userId) {
  const sh = usersSheet_(), last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === userId) return i + 2;
  }
  return -1;
}

function findDataRow_(userId, market) {
  const sh = udSheet_(), last = sh.getLastRow();
  if (last < 2) return -1;
  const v = sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim() === userId && String(v[i][1]).trim() === market) return i + 2;
  }
  return -1;
}

function blankRow_(userId, market) {
  return [userId, market, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '', '', '', '', ''];
}

function signUp(userId, pw) {
  userId = String(userId || '').trim();
  if (userId.length < 2) return { ok: false, msg: '아이디는 2자 이상 입력해주세요.' };
  if (String(pw || '').length < 2) return { ok: false, msg: '비밀번호는 2자 이상 입력해주세요.' };
  if (findUserRow_(userId) !== -1) return { ok: false, msg: '이미 사용 중인 아이디입니다.' };

  usersSheet_().appendRow([userId, hashPw_(pw), new Date()]);
  const ud = udSheet_();
  ud.appendRow(blankRow_(userId, 'domestic'));
  ud.appendRow(blankRow_(userId, 'overseas'));
  SpreadsheetApp.flush();
  return { ok: true, userId: userId };
}

function login(userId, pw) {
  userId = String(userId || '').trim();
  const row = findUserRow_(userId);
  if (row === -1) return { ok: false, msg: '가입되지 않은 아이디입니다.' };
  if (String(usersSheet_().getRange(row, 2).getValue()) !== hashPw_(pw)) {
    return { ok: false, msg: '비밀번호가 일치하지 않습니다.' };
  }
  const ud = udSheet_();
  ['domestic', 'overseas'].forEach(function (m) {
    if (findDataRow_(userId, m) === -1) ud.appendRow(blankRow_(userId, m));
  });
  SpreadsheetApp.flush();
  return { ok: true, userId: userId };
}

// ===== 핵심 계산 =====
// persist=true 일 때만 하단관찰 시작일과 전고점을 시트에 기록한다.
function compute_(userId, market, cashAsset, newDeposit, sharesArr, persist) {
  userId = String(userId || '').trim();
  market = mk_(market);

  const sh = udSheet_();
  const row = findDataRow_(userId, market);
  if (row === -1) throw new Error('사용자 데이터를 찾을 수 없습니다. 다시 로그인해주세요.');

  const v = sh.getRange(row, 1, 1, C_LAST).getValues()[0];
  const cumDeposit = Number(v[C_CUM - 1]) || 0;
  let peakNet = Number(v[C_PEAK - 1]) || 0;
  let peakCum = Number(v[C_PEAKCUM - 1]) || 0;

  const base = assetSheet_(market).getRange('A6:E' + (5 + N)).getValues();
  const isKRW = market === 'domestic';
  const rnd = function (x) { return isKRW ? Math.round(x) : Math.round(x * 100) / 100; };

  let assets = [], total = 0;
  for (let i = 0; i < N; i++) {
    const price = Number(base[i][4]) || 0;
    const shares = Math.max(0, Math.floor(Number(sharesArr[i]) || 0));
    const amt = price * shares;
    total += amt;
    assets.push({
      name: base[i][0], code: String(base[i][1]).trim(),
      short: shortName_(base[i][1]), usTicker: usTicker_(base[i][1]),
      target: Number(base[i][2]) || 0, band: Number(base[i][3]) || 0,
      price: price, shares: shares, currentAmt: amt, adjAmt: 0, adjShares: 0
    });
  }

  // 총자산 = 종목 평가액 + 통장 현금 + 이번 신규 입금액.
  // 매도해도 이 값은 변하지 않으므로 모든 비율의 기준으로 쓴다.
  const cashPool = (Number(cashAsset) || 0) + (Number(newDeposit) || 0);
  const newTotal = total + cashPool;

  // ① 상단 초과분만 매도 — 상단선까지만 판다(목표까지 내리지 않음)
  let pool = cashPool;
  assets.forEach(function (a) {
    a.pct = newTotal > 0 ? a.currentAmt / newTotal * 100 : 0;
    a.upper = a.target + a.band;
    a.isOver = a.pct > a.upper;
    a.sellAmt = a.isOver ? a.currentAmt - newTotal * a.upper / 100 : 0;
    pool += a.sellAmt;
  });

  // ② 목표 대비 부족분에 비례 배분
  let sfSum = 0;
  assets.forEach(function (a) {
    a.shortfall = Math.max(newTotal * a.target / 100 - (a.currentAmt - a.sellAmt), 0);
    sfSum += a.shortfall;
  });
  assets.forEach(function (a) {
    const buy = sfSum > 0 ? pool * a.shortfall / sfSum
                          : pool * a.target / 100;   // 전부 목표 이상이면 목표 비중대로
    a.adjAmt = rnd(buy - a.sellAmt);
  });

  // 주식 수 (매수 내림 / 매도 올림, 보유량 초과 매도 방지)
  assets.forEach(function (a) {
    if (a.price <= 0) { a.adjShares = 0; return; }
    a.adjShares = a.adjAmt >= 0
      ? Math.floor(a.adjAmt / a.price)
      : Math.max(-Math.ceil(-a.adjAmt / a.price), -a.shares);
  });

  // 남는 현금으로 부족분 큰 쪽부터 1주씩 추가 매수
  let left = pool - spent_(assets);
  for (let g = 0; g < 500; g++) {
    let best = -1, bestSf = 0;
    assets.forEach(function (a, i) {
      if (a.price <= 0 || a.price > left || a.target <= 0) return;
      const sf = newTotal * a.target / 100 - (a.currentAmt + a.adjShares * a.price);
      if (sf > bestSf) { bestSf = sf; best = i; }
    });
    if (best < 0) break;
    assets[best].adjShares += 1;
    left -= assets[best].price;
  }

  // 하단 관찰 — 목표−밴드 아래로 내려간 시점 기록
  const td = today_();
  let below = [], dirty = false;
  const belowCells = [];
  for (let i = 0; i < N; i++) {
    const a = assets[i];
    let start = toDateStr_(v[C_BELOW - 1 + i]);
    const isBelow = a.pct < (a.target - a.band);
    if (isBelow && !start) { start = td; dirty = true; }
    if (!isBelow && start) { start = ''; dirty = true; }
    belowCells.push(start);
    if (isBelow && start) below.push({ name: a.short || a.name, days: daysBetween_(start, td) });
  }

  // 전고점 · 최고 수익률 (순수 시장가치 = 총자산 − 누적 입금액)
  const netValue = newTotal - cumDeposit;
  if (cumDeposit > 0 && netValue > peakNet) {
    peakNet = netValue; peakCum = cumDeposit; dirty = true;
  }

  if (persist && dirty) {
    sh.getRange(row, C_PEAK).setValue(peakNet);
    sh.getRange(row, C_PEAKCUM).setValue(peakCum);
    sh.getRange(row, C_BELOW, 1, N).setValues([belowCells]);
  }

  // 해외만 환율 조회 (평가금액 원화 환산 표시용)
  const fx = market === 'overseas' ? quoteOne_('CURRENCY:USDKRW') : 0;

  const s = spent_(assets), g = gained_(assets);
  return {
    userId: userId, market: market,
    cashAsset: Number(cashAsset) || 0, newDeposit: Number(newDeposit) || 0,
    cumDeposit: cumDeposit,
    total: total, newTotal: newTotal, fx: fx,
    netValue: netValue,
    rate: cumDeposit > 0 ? netValue / cumDeposit * 100 : null,
    peakRate: peakCum > 0 ? peakNet / peakCum * 100 : null,
    assets: assets, below: below,
    spent: s, gained: g, leftover: pool - s,
    priceWarning: assets.some(function (a) { return a.price <= 0; })
      ? '현재가가 조회되지 않은 종목이 있습니다. 시트를 확인해주세요.' : ''
  };
}

function spent_(a) {
  return a.reduce(function (t, x) { return t + (x.adjShares > 0 ? x.adjShares * x.price : 0); }, 0);
}
function gained_(a) {
  return a.reduce(function (t, x) { return t + (x.adjShares < 0 ? -x.adjShares * x.price : 0); }, 0);
}

function parseShares_(raw) {
  const arr = String(raw || '').split(',');
  const out = [];
  for (let i = 0; i < N; i++) out.push(Math.max(0, Math.floor(Number(arr[i]) || 0)));
  return out;
}

// 저장된 상태 그대로 불러오기
function loadState(userId, market) {
  userId = String(userId || '').trim();
  market = mk_(market);
  const sh = udSheet_();
  const row = findDataRow_(userId, market);
  if (row === -1) throw new Error('사용자 데이터를 찾을 수 없습니다. 다시 로그인해주세요.');
  const v = sh.getRange(row, 1, 1, C_LAST).getValues()[0];
  const shares = [];
  for (let i = 0; i < N; i++) shares.push(Number(v[C_SHARES - 1 + i]) || 0);
  return compute_(userId, market, Number(v[C_CASH - 1]) || 0, Number(v[C_DEP - 1]) || 0, shares, true);
}

// 계산만 — 시트에 아무것도 쓰지 않음
function calcOnly(userId, market, cash, dep, sharesRaw) {
  return compute_(userId, market, Number(cash) || 0, Number(dep) || 0, parseShares_(sharesRaw), false);
}

// 매매 완료 저장 — 실제 매매 내역(보유수량 변화)을 로그에 남기고 입력칸을 비운다
function saveState(userId, market, cash, dep, sharesRaw) {
  userId = String(userId || '').trim();
  market = mk_(market);
  const sh = udSheet_();
  const row = findDataRow_(userId, market);
  if (row === -1) throw new Error('사용자 데이터를 찾을 수 없습니다. 다시 로그인해주세요.');

  const before = sh.getRange(row, C_SHARES, 1, N).getValues()[0].map(function (x) {
    return Number(x) || 0;
  });
  const after = parseShares_(sharesRaw);
  const cashNow = Math.max(0, Number(cash) || 0);
  const depNow = Math.max(0, Number(dep) || 0);
  const cum = (Number(sh.getRange(row, C_CUM).getValue()) || 0) + depNow;

  // 저장: 보유수량은 입력값, 누적 원금은 가산, 현금·입금액 칸은 비움
  sh.getRange(row, C_SHARES, 1, N).setValues([after]);
  sh.getRange(row, C_CUM).setValue(cum);
  sh.getRange(row, C_CASH).setValue(0);
  sh.getRange(row, C_DEP).setValue(0);
  SpreadsheetApp.flush();

  // 로그: 계산 예상치가 아니라 실제로 바뀐 보유수량 차이를 기록 (짧은 이름 사용)
  const base = assetSheet_(market).getRange('A6:B' + (5 + N)).getValues();
  const parts = [];
  for (let i = 0; i < N; i++) {
    const d = after[i] - before[i];
    if (d === 0) continue;
    const nm = shortName_(base[i][1]) || base[i][0];
    parts.push(nm + ' ' + (d > 0 ? '매수 ' : '매도 ') + Math.abs(d) + '주');
  }
  appendLog_(userId, market, parts.length ? parts.join(', ') : '수량 변동 없음', cashNow, depNow);

  return compute_(userId, market, 0, 0, after, true);
}

// ===== 로그 =====
function logSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName('Log');
  if (!sh) {
    sh = ss.insertSheet('Log');
    sh.appendRow(['userId', 'market', 'date', 'summary', 'cash', 'deposit']);
  }
  return sh;
}

// 날짜를 문자열로 넣어 시트가 Date로 바꾸지 못하게 한다
function appendLog_(userId, market, summary, cash, deposit) {
  logSheet_().appendRow([userId, market, "'" + today_(), summary, cash || 0, deposit || 0]);
}

function getRecentLogs(userId, market) {
  userId = String(userId || '').trim();
  market = mk_(market);
  const sh = logSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 6).getValues();
  const mine = rows.filter(function (r) {
    return String(r[0]).trim() === userId && String(r[1]).trim() === market;
  });
  return mine.slice(-10).reverse().map(function (r) {
    return {
      date: toDateStr_(r[2]),
      summary: r[3],
      cash: Number(r[4]) || 0,
      deposit: Number(r[5]) || 0
    };
  });
}

// ===== ETF 운용자산 규모 + 괴리율 =====
// 네이버금융 공개 목록 하나로 순자산(marketSum)과 괴리율(nowVal vs nav)을 함께 구한다.
// 종목 페이지를 따로 긁지 않으므로 페이지 구조 변경에 영향받지 않는다.
// 해외 종목은 이 목록에 없으므로 -1(조회 안 됨) 처리.
function getAumInfo(market) {
  market = mk_(market);
  const base = assetSheet_(market).getRange('A6:B' + (5 + N)).getValues();
  const out = base.map(function (r) {
    return { name: r[0], short: shortName_(r[1]), code: String(r[1]).trim(), aum: -1, gap: null };
  });
  if (market !== 'domestic') return out;

  const opt = {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      // User-Agent가 없으면 차단되는 경우가 있어 브라우저처럼 보내야 함
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Referer': 'https://finance.naver.com/sise/etf.naver'
    }
  };

  let map = {};
  try {
    const res = UrlFetchApp.fetch(
      'https://finance.naver.com/api/sise/etfItemList.nhn?etfType=0&targetColumn=market_sum&sortOrder=desc',
      opt);
    if (res.getResponseCode() === 200) {
      const json = JSON.parse(res.getContentText('UTF-8'));
      const list = (json && json.result && json.result.etfItemList) || [];
      list.forEach(function (it) { map[String(it.itemcode).trim()] = it; });
    }
  } catch (e) { map = {}; }

  out.forEach(function (o) {
    const hit = map[o.code];
    if (!hit) return;

    const sum = Number(hit.marketSum);   // 단위: 억원
    if (sum > 0) o.aum = sum;

    // 괴리율 = (시장가격 − 순자산가치) / 순자산가치 × 100
    const now = Number(hit.nowVal), nav = Number(hit.nav);
    if (now > 0 && nav > 0) o.gap = Math.round((now - nav) / nav * 10000) / 100;
  });
  return out;
}

// ===== 시세 =====
function quoteOne_(symbol) {
  try {
    const t = tmpSheet_();
    t.clear();
    t.getRange('A1').setFormula('=IFERROR(GOOGLEFINANCE("' + symbol + '"),0)');
    SpreadsheetApp.flush();
    Utilities.sleep(600);
    const val = Number(t.getRange('A1').getValue()) || 0;
    t.clear();
    return val;
  } catch (e) { return 0; }
}

// 국내: 네이버금융 공개 API로 일별 종가 시계열을 가져온다.
// GOOGLEFINANCE의 국내 종목 과거 시세 조회가 불안정해서(특히 나스닥100 등 해외지수 추종 ETF),
// 이 방식이 훨씬 안정적이다. 실패하면 null → 상위에서 GOOGLEFINANCE로 폴백.
function fetchNaverDaily_(code, days) {
  try {
    const endStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
    const startD = new Date();
    startD.setDate(startD.getDate() - (days || 400));
    const startStr = Utilities.formatDate(startD, 'Asia/Seoul', 'yyyyMMdd');

    const url = 'https://api.finance.naver.com/siseJson.naver?symbol=' + code +
      '&requestType=1&startTime=' + startStr + '&endTime=' + endStr + '&timeframe=day';
    const opt = {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://finance.naver.com/'
      }
    };
    const res = UrlFetchApp.fetch(url, opt);
    if (res.getResponseCode() !== 200) return null;

    // 응답이 진짜 JSON이 아니라 작은따옴표 쓰는 JS 배열 리터럴이라 손봐서 파싱한다.
    let text = res.getContentText('UTF-8').trim();
    if (!text) return null;
    text = text.replace(/'/g, '"').replace(/,\s*\]/g, ']');
    const arr = JSON.parse(text);
    if (!arr || arr.length < 2) return null;

    let s = [];
    for (let i = 1; i < arr.length; i++) {
      const row = arr[i];
      const ds = String(row[0] || '').trim();
      const close = Number(row[4]);
      if (ds.length !== 8 || !close) continue;
      const y = ds.slice(0, 4), m = ds.slice(4, 6), d = ds.slice(6, 8);
      const dt = new Date(Number(y), Number(m) - 1, Number(d));
      s.push({ d: dt.getTime(), p: close });
    }
    if (s.length < 2) return null;
    s.sort(function (a, b) { return a.d - b.d; });
    return s;
  } catch (e) { return null; }
}

// 해외: 기존 GOOGLEFINANCE 방식 (미국 종목은 안정적으로 지원됨)
function fetchGoogleFinanceDaily_(market, code) {
  try {
    const t = tmpSheet_();
    t.clear();
    t.getRange('A1').setFormula(
      '=GOOGLEFINANCE("' + ticker_(market, code) + '","close",TODAY()-400,TODAY())');
    SpreadsheetApp.flush();
    Utilities.sleep(1200);

    const last = t.getLastRow();
    if (last < 3) { t.clear(); return null; }
    const raw = t.getRange(2, 1, last - 1, 2).getValues();
    t.clear();

    let s = [];
    raw.forEach(function (r) {
      if (r[0] instanceof Date && typeof r[1] === 'number' && r[1] > 0) {
        s.push({ d: r[0].getTime(), p: r[1] });
      }
    });
    if (s.length < 2) return null;
    s.sort(function (a, b) { return a.d - b.d; });
    return s;
  } catch (e) { return null; }
}

// 종목 1개씩 조회 → 화면에서 N번 호출하며 카운터 갱신
function getReturnOne(market, index) {
  market = mk_(market);
  const base = assetSheet_(market).getRange('A6:B' + (5 + N)).getValues();
  const name = base[index][0], code = String(base[index][1] || '').trim();
  const keys = ['1일', '1주일', '1개월', '6개월', '1년'];
  const out = {
    name: name, short: shortName_(code), usTicker: usTicker_(code),
    code: code, values: {}, mdd: null
  };
  keys.forEach(function (k) { out.values[k] = null; });
  if (!code) return out;

  // 국내는 네이버 API 먼저 시도, 실패하면 GOOGLEFINANCE로 폴백. 해외는 GOOGLEFINANCE만 사용.
  let s = market === 'domestic' ? fetchNaverDaily_(code, 400) : null;
  if (!s) s = fetchGoogleFinanceDaily_(market, code);
  if (!s || s.length < 2) return out;

  const now = s[s.length - 1];
  [[1, '1일'], [7, '1주일'], [30, '1개월'], [182, '6개월'], [365, '1년']].forEach(function (pd) {
    const cut = now.d - pd[0] * 86400000;
    for (let k = s.length - 1; k >= 0; k--) {
      if (s[k].d <= cut) { out.values[pd[1]] = (now.p - s[k].p) / s[k].p * 100; return; }
    }
  });

  // 최근 1년 MDD
  const yearAgo = now.d - 365 * 86400000;
  let peak = 0, mdd = 0, seen = false;
  s.forEach(function (x) {
    if (x.d < yearAgo) return;
    seen = true;
    if (x.p > peak) peak = x.p;
    if (peak > 0) mdd = Math.max(mdd, (peak - x.p) / peak * 100);
  });
  if (seen) out.mdd = -mdd;

  return out;
}

// ===== 진단용 (필요할 때만 실행) =====
function debugAum() {
  Logger.log(JSON.stringify(getAumInfo('domestic')));
}
function debugRet() {
  Logger.log(JSON.stringify(getReturnOne('domestic', 0)));
}
