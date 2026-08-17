/**
 * 5분할 리밸런싱 포트폴리오 — API 전용 (화면은 Vercel에서 그림)
 * 배포: 실행 = 나, 액세스 = 링크가 있는 모든 사용자 → /exec 주소 사용
 */

// GET 하나로 전부 처리. callback 파라미터가 있으면 JSONP로 응답(CORS 우회).
// 화면 표시용 짧은 이름 (종목코드/티커 기준)
const SHORT_NAME = {
  '133690': '나스닥',   'QQQ':  '나스닥',
  '0137V0': 'S&P500',  'SPMO': 'S&P500',
  '458730': '슈드',     'SCHD': '슈드',
  '0046Y0': '배당퀄리티', 'DGRW': '배당퀄리티',
  '456610': '초단기채',  'SGOV': '초단기채'
};
function shortName_(code) {
  return SHORT_NAME[String(code).trim().toUpperCase()] || SHORT_NAME[String(code).trim()] || '';
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const shares = String(p.shares || '').split(',');
  let out;
  try {
    switch (p.action) {
      case 'login':   out = login(p.user, p.pw); break;
      case 'signup':  out = signUp(p.user, p.pw); break;
      case 'load':    out = getSheetData(p.user, p.market); break;
      case 'save':    out = saveAndCalc(p.user, p.market, Number(p.cash), Number(p.dep), shares); break;
      case 'logs':    out = getRecentLogs(p.user, p.market); break;
      case 'aum':     out = getAumInfo(p.market); break;
      case 'ret':     out = getReturnOne(p.market, Number(p.index)); break;
      default:        out = { error: '알 수 없는 요청입니다: ' + p.action };
    }
  } catch (err) {
    out = { error: String(err && err.message || err) };
  }
  const body = JSON.stringify(out);
  if (p.callback) {
    // ponytail: 콜백 이름은 프론트에서 __cbN 형태로만 생성 — 별도 검증 없이 그대로 씀
    return ContentService.createTextOutput(p.callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

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

// ===== 시트 접근 =====
function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function usersSheet_() { return ss_().getSheetByName('Users'); }
function udSheet_() { return ss_().getSheetByName('UserData'); }
function assetSheet_(market) {
  return market === 'overseas' ? ss_().getSheetByName('Overseas') : ss_().getSheets()[0];
}
function ticker_(market, code) {
  code = String(code).trim();
  return market === 'overseas' ? (OV_TICKER[code.toUpperCase()] || code) : 'KRX:' + code;
}
function mk_(m) { return m === 'overseas' ? 'overseas' : 'domestic'; }

function tmpSheet_() {
  const ss = ss_();
  let t = ss.getSheetByName('_tmpQuote');
  if (!t) { t = ss.insertSheet('_tmpQuote'); t.hideSheet(); }
  return t;
}

function today_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }

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

// 신규 행: [userId, market, cash, dep, shares×5, cum, peak, peakCum, below×5]
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

// ===== 메인 계산 =====
function getSheetData(userId, market) {
  userId = String(userId || '').trim();
  market = mk_(market);

  const sh = udSheet_();
  const row = findDataRow_(userId, market);
  if (row === -1) throw new Error('사용자 데이터를 찾을 수 없습니다. 다시 로그인해주세요.');

  const v = sh.getRange(row, 1, 1, C_LAST).getValues()[0];
  const cashAsset = Number(v[C_CASH - 1]) || 0;
  const newDeposit = Number(v[C_DEP - 1]) || 0;
  const cumDeposit = Number(v[C_CUM - 1]) || 0;
  let peakNet = Number(v[C_PEAK - 1]) || 0;
  let peakCum = Number(v[C_PEAKCUM - 1]) || 0;

  const base = assetSheet_(market).getRange('A6:E' + (5 + N)).getValues();
  const isKRW = market === 'domestic';
  const rnd = function (x) { return isKRW ? Math.round(x) : Math.round(x * 100) / 100; };

  let assets = [], total = 0;
  for (let i = 0; i < N; i++) {
    const price = Number(base[i][4]) || 0;
    const shares = Number(v[C_SHARES - 1 + i]) || 0;
    const amt = price * shares;
    total += amt;
    assets.push({
      name: base[i][0], code: String(base[i][1]), short: shortName_(base[i][1]),
      target: Number(base[i][2]) || 0, band: Number(base[i][3]) || 0,
      price: price, shares: shares, currentAmt: amt, adjAmt: 0, adjShares: 0
    });
  }

  // 총자산 = 종목 평가액 + 통장 현금 + 이번 신규 입금액. 매도해도 이 값은 변하지 않으므로 모든 비율의 기준으로 씀.
  const cashPool = cashAsset + newDeposit;
  const newTotal = total + cashPool;

  // ① 상단 초과분만 매도 (상단선까지만 판다. 목표까지 내리지 않음)
  let pool = cashPool;
  assets.forEach(function (a) {
    a.pct = newTotal > 0 ? a.currentAmt / newTotal * 100 : 0;
    a.upper = a.target + a.band;
    a.isOver = a.pct > a.upper;
    a.sellAmt = a.isOver ? a.currentAmt - newTotal * a.upper / 100 : 0;
    pool += a.sellAmt;
  });

  // ② 남은 돈을 목표 대비 부족분에 비례해 배분
  let sfSum = 0;
  assets.forEach(function (a) {
    a.shortfall = Math.max(newTotal * a.target / 100 - (a.currentAmt - a.sellAmt), 0);
    sfSum += a.shortfall;
  });
  assets.forEach(function (a) {
    const buy = sfSum > 0
      ? pool * a.shortfall / sfSum
      : pool * a.target / 100;   // 전부 목표 이상이면 목표 비중대로 배분
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

  // 하단 관찰: 목표−밴드 아래로 내려간 시점 기록 (ponytail: 5종 공통 규칙 — 위험자산은 15%, SOFR은 17%)
  const td = today_();
  let below = [], dirty = false;
  for (let i = 0; i < N; i++) {
    const a = assets[i];
    const raw = v[C_BELOW - 1 + i];
    // 구글시트가 날짜 문자열을 자동으로 진짜 Date로 바꿔버려서, 타입 보고 안전하게 문자열화
    let start = raw instanceof Date
      ? Utilities.formatDate(raw, 'Asia/Seoul', 'yyyy-MM-dd')
      : (raw ? String(raw).slice(0, 10) : '');
    const isBelow = a.pct < (a.target - a.band);
    if (isBelow && !start) { start = td; dirty = true; }
    if (!isBelow && start) { start = ''; dirty = true; }
    v[C_BELOW - 1 + i] = start;
    if (isBelow && start) below.push({ name: a.short || a.name, days: daysBetween_(start, td) });
  }

  // 전고점 · 최고 수익률 (순수 시장가치 = 총자산 − 누적 입금액)
  const netValue = newTotal - cumDeposit;
  if (cumDeposit > 0 && netValue > peakNet) {
    peakNet = netValue; peakCum = cumDeposit; dirty = true;
  }
  if (dirty) {
    sh.getRange(row, C_PEAK).setValue(peakNet);
    sh.getRange(row, C_PEAKCUM).setValue(peakCum);
    sh.getRange(row, C_BELOW, 1, N).setValues([v.slice(C_BELOW - 1, C_BELOW - 1 + N)]);
  }

  // 해외만 환율 조회 (평가금액 원화 환산 표시용)
  let fx = 0;
  if (market === 'overseas') fx = quoteOne_('CURRENCY:USDKRW');

  const s = spent_(assets), g = gained_(assets);
  return {
    userId: userId, market: market,
    cashAsset: cashAsset, newDeposit: newDeposit, cumDeposit: cumDeposit,
    total: total, newTotal: newTotal, fx: fx,
    netValue: netValue,
    rate: cumDeposit > 0 ? netValue / cumDeposit * 100 : null,
    peakRate: peakCum > 0 ? peakNet / peakCum * 100 : null,
    hasSell: assets.some(function (a) { return a.adjShares < 0; }),
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
function daysBetween_(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}

// ===== 저장 =====
// 신규 입금액은 저장 시 누적 입금액에 더하고 입력칸을 비움 (두 번 눌러도 중복 계상 안 됨)
function saveAndCalc(userId, market, cashAsset, newDeposit, sharesArr) {
  userId = String(userId || '').trim();
  market = mk_(market);
  const sh = udSheet_();
  const row = findDataRow_(userId, market);
  if (row === -1) throw new Error('사용자 데이터를 찾을 수 없습니다. 다시 로그인해주세요.');

  const dep = Math.max(0, Number(newDeposit) || 0);
  const cum = (Number(sh.getRange(row, C_CUM).getValue()) || 0) + dep;

  sh.getRange(row, C_CASH).setValue(Math.max(0, Number(cashAsset) || 0));
  sh.getRange(row, C_DEP).setValue(0);
  sh.getRange(row, C_CUM).setValue(cum);
  sh.getRange(row, C_SHARES, 1, N).setValues([
    sharesArr.slice(0, N).map(function (x) { return Math.max(0, Math.floor(Number(x) || 0)); })
  ]);
  SpreadsheetApp.flush();
  const result = getSheetData(userId, market);

  const parts = [];
  result.assets.forEach(function (a) {
    const nm = a.short || a.name;
    if (a.adjShares > 0) parts.push(nm + ' +' + a.adjShares);
    if (a.adjShares < 0) parts.push(nm + ' −' + (-a.adjShares));
  });
  appendLog_(userId, market,
    (parts.length ? parts.join(', ') : '변동 없음'),
    Math.max(0, Number(cashAsset) || 0), dep);

  return result;
}

// 시장 전환 시 조용히 저장 (신규 입금액도 그대로 반영)
function saveOnly(userId, market, cashAsset, newDeposit, sharesArr) {
  try { saveAndCalc(userId, market, cashAsset, newDeposit, sharesArr); } catch (e) {}
  return { ok: true };
}

// ===== 시세 조회 =====
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

// ===== 로그 (최근 10건) =====
function logSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName('Log');
  if (!sh) {
    sh = ss.insertSheet('Log');
    sh.appendRow(['userId', 'market', 'date', 'summary', 'cash', 'deposit']);
  }
  return sh;
}

// ponytail: 매번 전체를 훑어 최근 10건을 찾음 — 사용자 1~2명, 로그 수백 줄 규모에서는 충분히 빠름.
// 로그가 수천 줄 넘어가면 그때 뒤에서부터 역순 탐색으로 바꾸면 됨.
function appendLog_(userId, market, summary, cash, deposit) {
  logSheet_().appendRow([userId, market, today_(), summary, cash || 0, deposit || 0]);
}

function getRecentLogs(userId, market) {
  userId = String(userId || '').trim(); market = mk_(market);
  const sh = logSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 6).getValues();
  const mine = rows.filter(function (r) {
    return String(r[0]).trim() === userId && String(r[1]).trim() === market;
  });
  return mine.slice(-10).reverse().map(function (r) {
    const d = r[2];
    return {
      date: d instanceof Date ? Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd') : String(d).slice(0, 10),
      summary: r[3],
      cash: Number(r[4]) || 0,
      deposit: Number(r[5]) || 0
    };
  });
}

// ===== ETF 운용자산 규모 + 괴리율 =====
// GOOGLEFINANCE의 marketcap은 국내 ETF에 안 먹혀서, 네이버금융 공개 목록(JSON)에서 가져옴.
// 해외 종목은 이 목록에 없으므로 -1(조회 안 됨) 처리.
function getAumInfo(market) {
  market = mk_(market);
  const base = assetSheet_(market).getRange('A6:B' + (5 + N)).getValues();
  const out = base.map(function (r) {
    return { name: r[0], short: shortName_(r[1]), code: String(r[1]).trim(), aum: -1, gap: null };
  });
  if (market !== 'domestic') return out;

  let list = null;
  try {
    const res = UrlFetchApp.fetch(
      'https://finance.naver.com/api/sise/etfItemList.nhn?etfType=0&targetColumn=market_sum&sortOrder=desc',
      { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() === 200) {
      const json = JSON.parse(res.getContentText('UTF-8'));
      list = json && json.result && json.result.etfItemList;
    }
  } catch (e) { list = null; }
  if (!list) return out;

  // itemcode → 항목 맵
  const map = {};
  list.forEach(function (it) { map[String(it.itemcode).trim()] = it; });

  out.forEach(function (o) {
    const hit = map[o.code];
    if (hit) {
      const sum = Number(hit.marketSum);   // 단위: 억원
      if (sum > 0) o.aum = sum;
    }
    o.gap = fetchGap_(o.code);
  });
  return out;
}

// 괴리율: 네이버 종목 페이지에서 숫자만 긁어옴. 실패하면 null (화면에는 '-')
// ponytail: 정식 파서 대신 정규식 한 줄 — 페이지 구조 바뀌면 조용히 null이 되고 나머지 기능엔 영향 없음.
function fetchGap_(code) {
  try {
    const res = UrlFetchApp.fetch('https://finance.naver.com/item/main.naver?code=' + code,
      { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return null;
    const html = res.getContentText('EUC-KR');
    const m = html.match(/괴리율[\s\S]{0,200}?(-?\d+\.\d+)\s*%/);
    return m ? Number(m[1]) : null;
  } catch (e) { return null; }
}

// 종목 1개씩 조회 → 화면에서 N번 호출하며 카운터 갱신
function getReturnOne(market, index) {
  market = mk_(market);
  const base = assetSheet_(market).getRange('A6:B' + (5 + N)).getValues();
  const name = base[index][0], code = String(base[index][1] || '').trim();
  const keys = ['1일', '1주일', '1개월', '6개월', '1년'];
  const out = { name: name, short: shortName_(code), code: code, values: {}, mdd: null };
  keys.forEach(function (k) { out.values[k] = null; });
  if (!code) return out;

  try {
    const t = tmpSheet_();
    t.clear();
    t.getRange('A1').setFormula(
      '=GOOGLEFINANCE("' + ticker_(market, code) + '","close",TODAY()-400,TODAY())');
    SpreadsheetApp.flush();
    Utilities.sleep(1200);

    const last = t.getLastRow();
    if (last < 3) { t.clear(); return out; }
    const raw = t.getRange(2, 1, last - 1, 2).getValues();
    t.clear();

    let s = [];
    raw.forEach(function (r) {
      if (r[0] instanceof Date && typeof r[1] === 'number' && r[1] > 0) s.push({ d: r[0].getTime(), p: r[1] });
    });
    if (s.length < 2) return out;
    s.sort(function (a, b) { return a.d - b.d; });

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
  } catch (e) { /* 데이터 없으면 null 유지 */ }

  return out;
}
