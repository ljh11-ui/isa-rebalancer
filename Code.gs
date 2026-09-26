/**
 * 분할 리밸런싱 포트폴리오 — API 전용 (화면은 Vercel에서 그림)
 * 규칙: 상단 초과분만 매도 → 목표 대비 부족분 비례 배분. 하단 밴드 없음.
 *
 * 배포: 실행 = 나 / 액세스 = 모든 사용자 → /exec 주소 사용
 *
 * 데이터 구조 (자유 포트폴리오)
 *   Assets   — 등록된 종목 카탈로그(전역, 모든 사용자 공유). market | code | name | short | symbol | price(수식)
 *   Accounts — 사용자별 계좌. 계좌 하나 = 한 행. 종목 구성·보유수량·하단관찰일은 assetsJson 한 칸에 담는다.
 * 예전 1번째 시트 / Overseas / UserData 는 첫 로그인 때 옮겨올 원본으로 읽기만 하고 더 이상 쓰지 않는다.
 * 단, 1번째 시트·Overseas 의 E열(현재가)은 기본 10종목 가격의 원본으로 계속 참조하므로 지우면 안 된다.
 */

const SHEET_ID = '1vjteD7fGeJqRJwv4Xx6MwYgdnT6JbCl2ZSRQmj6ERfA';
const MAX_ACCTS = 5, MAX_ASSETS = 10;

// 예전 고정 5종목 구조 — 첫 로그인 이관(migrateLegacy_)에만 쓴다
const LEGACY_N = 5;
const C_CASH = 3, C_DEP = 4, C_SHARES = 5, C_CUM = 10,
      C_PEAK = 11, C_PEAKCUM = 12, C_BELOW = 13, C_LAST = 17;

// Accounts 열 (0-based 배열 위치)
const AC_HEAD = ['userId', 'acctId', 'name', 'market', 'cash', 'deposit',
                 'cumDeposit', 'peakNet', 'peakCum', 'assetsJson', 'createdAt'];
const AC_LAST = AC_HEAD.length;

// 해외 티커 → GOOGLEFINANCE 표기 (거래소 접두어가 종목마다 다름)
const OV_TICKER = {
  QQQ: 'NASDAQ:QQQ', SPMO: 'NYSEARCA:SPMO', SCHD: 'NYSEARCA:SCHD',
  DGRW: 'NASDAQ:DGRW', SGOV: 'SGOV'
};

// 화면 표시용 짧은 이름 (기본 10종목을 카탈로그에 처음 넣을 때만 사용)
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
  // market= 은 예전 화면 호환용 — 배포 전환 중 옛 화면이 load/calc/save 를 불러도
  // 이관된 계좌 id 가 'domestic'/'overseas' 라 그대로 맞물린다.
  const acct = p.acct || p.market;
  let out;
  try {
    switch (p.action) {
      case 'login':    out = login(p.user, p.pw); break;
      case 'signup':   out = signUp(p.user, p.pw); break;
      case 'withdraw': out = deleteAccount(p.user, p.pw); break;
      case 'load':     out = loadState(p.user, acct); break;
      case 'calc':     out = calcOnly(p.user, acct, p.cash, p.dep, p.shares); break;
      case 'save':     out = saveState(p.user, acct, p.cash, p.dep, p.shares); break;
      case 'logs':     out = getRecentLogs(p.user, acct); break;
      case 'aum':      out = getAumInfo(p.user, acct); break;
      case 'retAll':   out = getReturns(p.user, acct); break;
      case 'catalog':  out = getCatalog(p.user, p.market); break;
      case 'lookup':   out = lookupAsset(p.user, p.market, p.code); break;
      case 'register': out = registerAsset(p.user, p.market, p.code, p.symbol, p.name); break;
      case 'addAcct':  out = addAcct(p.user, p.name, p.market); break;
      case 'savePf':   out = savePortfolio(p.user, acct, p.name, p.spec); break;
      case 'delAcct':  out = deleteAcct(p.user, acct); break;
      default:         out = { error: '알 수 없는 요청입니다: ' + p.action };
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
function legacySheet_(market) {
  return market === 'overseas' ? ss_().getSheetByName('Overseas') : ss_().getSheets()[0];
}
function ticker_(market, code) {
  const c = String(code).trim();
  return market === 'overseas' ? (OV_TICKER[c.toUpperCase()] || c) : 'KRX:' + c;
}
function mk_(m) { return String(m).trim() === 'overseas' ? 'overseas' : 'domestic'; }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }

// 사용자가 친 글자를 시트·화면에 넣기 전에 다듬는다. 카탈로그 이름은 모든 사용자 화면에
// 그대로 그려지므로 HTML·따옴표 문자를 빼서 남의 화면에 코드를 심지 못하게 한다.
function clean_(s, max) {
  return String(s == null ? '' : s).replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
// 시트에 글자로 넣을 값 — 앞에 ' 를 붙이면 "=..."가 수식이 되거나 "069500"이 숫자로 바뀌지 않는다
function txt_(s) { return "'" + s; }

// 없으면 만들고 머리글을 단다. 맨 끝에 붙인다 — 예전 국내 시트는 "첫 번째 시트"로
// 찾기 때문에 새 시트가 앞에 끼면 엉뚱한 시트를 읽게 된다.
function sheet_(name, header, seed) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sh = ss.getSheetByName(name);          // 기다리는 사이 다른 요청이 만들었을 수 있다
    if (sh) return sh;
    sh = ss.insertSheet(name, ss.getSheets().length);
    sh.appendRow(header);
    try { if (seed) seed(sh); }
    catch (e) { ss.deleteSheet(sh); throw e; }   // 반쯤 채워진 채로 남으면 다음에 다시 못 채운다
    SpreadsheetApp.flush();
    return sh;
  } finally { lock.releaseLock(); }
}

function tmpSheet_(name) {
  const ss = ss_();
  let t = ss.getSheetByName(name);
  if (!t) { t = ss.insertSheet(name, ss.getSheets().length); t.hideSheet(); }
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

// 예전 UserData 행 찾기 — 이관할 때만 쓴다
function findDataRow_(userId, market) {
  const sh = udSheet_();
  if (!sh) return -1;
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const v = sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim() === userId && String(v[i][1]).trim() === market) return i + 2;
  }
  return -1;
}

function signUp(userId, pw) {
  userId = String(userId || '').trim();
  if (userId.length < 2) return { ok: false, msg: '아이디는 2자 이상 입력해주세요.' };
  if (String(pw || '').length < 2) return { ok: false, msg: '비밀번호는 2자 이상 입력해주세요.' };
  if (findUserRow_(userId) !== -1) return { ok: false, msg: '이미 사용 중인 아이디입니다.' };

  // 기본 계좌 두 개는 첫 load 때 accountsFor_ 가 만들어준다
  usersSheet_().appendRow([userId, hashPw_(pw), new Date()]);
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
  return { ok: true, userId: userId };
}

// 행을 아래에서 위로 지운다 — 위에서부터 지우면 남은 행 번호가 당겨져 엉뚱한 행을 지운다
function deleteRowsWhere_(sh, col, userId) {
  if (!sh) return;
  const last = sh.getLastRow();
  if (last < 2) return;
  const ids = sh.getRange(2, col, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).trim() === userId) sh.deleteRow(i + 2);
  }
}

// 계정 탈퇴 — Users / Accounts / UserData / Log 에서 해당 아이디 행을 전부 지운다.
// 비밀번호를 다시 확인해 본인 확인 없이는 지울 수 없게 한다.
function deleteAccount(userId, pw) {
  userId = String(userId || '').trim();
  const row = findUserRow_(userId);
  if (row === -1) return { ok: false, msg: '가입되지 않은 아이디입니다.' };
  if (String(usersSheet_().getRange(row, 2).getValue()) !== hashPw_(pw)) {
    return { ok: false, msg: '비밀번호가 일치하지 않습니다.' };
  }
  usersSheet_().deleteRow(row);
  deleteRowsWhere_(acctsSheet_(), 1, userId);
  deleteRowsWhere_(udSheet_(), 1, userId);
  deleteRowsWhere_(logSheet_(), 1, userId);
  SpreadsheetApp.flush();
  return { ok: true };
}

// ===== 종목 카탈로그 (Assets) =====
function priceFormula_(sym) { return '=IFERROR(GOOGLEFINANCE("' + sym + '"),0)'; }

function assetsSheet_() {
  return sheet_('Assets', ['market', 'code', 'name', 'short', 'symbol', 'price'], function (sh) {
    // 첫 실행 — 지금 쓰던 국내 5·해외 5종목을 미리 등록해 둔다.
    // 가격은 예전 시트 E열을 그대로 가리킨다. 이미 잘 돌던 수식이라 새로 만들면 오히려
    // 영문이 섞인 새 종목코드(0137V0 등)에서 안 될 위험만 생긴다.
    const rows = [];
    ['domestic', 'overseas'].forEach(function (m) {
      const src = legacySheet_(m);
      const ref = "'" + src.getName().replace(/'/g, "''") + "'!E";
      src.getRange('A6:B' + (5 + LEGACY_N)).getValues().forEach(function (r, i) {
        const code = String(r[1]).trim();
        if (!code) return;
        const nm = clean_(r[0], 40) || code;
        rows.push([m, txt_(code), txt_(nm), txt_(shortName_(code) || nm), ticker_(m, code),
                   '=IFERROR(' + ref + (6 + i) + ',0)']);
      });
    });
    if (rows.length) sh.getRange(2, 1, rows.length, 6).setValues(rows);
  });
}

function catalog_(market) {
  const sh = assetsSheet_(), last = sh.getLastRow(), map = {};
  if (last < 2) return map;
  sh.getRange(2, 1, last - 1, 6).getValues().forEach(function (r, i) {
    const code = String(r[1]).trim();
    if (!code || mk_(r[0]) !== market) return;
    const name = String(r[2]).trim() || code;
    map[code] = { code: code, name: name, short: String(r[3]).trim() || name,
                  symbol: String(r[4]).trim(), price: Number(r[5]) || 0, row: i };
  });
  return map;
}

function needUser_(userId) {
  userId = String(userId || '').trim();
  if (findUserRow_(userId) === -1) throw new Error('가입되지 않은 아이디입니다. 다시 로그인해주세요.');
  return userId;
}

function getCatalog(userId, market) {
  needUser_(userId);
  const map = catalog_(mk_(market));
  // 등록 순서대로 — Object.keys 는 "133690"처럼 숫자로만 된 키를 먼저 숫자순으로 늘어놓는다
  return Object.keys(map).map(function (k) { return map[k]; })
               .sort(function (a, b) { return a.row - b.row; });
}

function normCode_(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(c)) throw new Error('종목코드 형식이 올바르지 않습니다.');
  return c;
}

// 종목코드 → 거래소 후보들을 한꺼번에 GOOGLEFINANCE 로 조회해 값이 나오는 첫 후보를 돌려준다.
// 시트에 쓰지 않는다 — 화면에서 사람이 이름·가격을 확인한 뒤 registerAsset 으로 등록한다.
function lookupAsset(userId, market, code) {
  needUser_(userId);
  market = mk_(market);
  code = normCode_(code);
  const hit = catalog_(market)[code];
  if (hit) return { ok: true, exists: true, code: code, symbol: hit.symbol, name: hit.name, price: hit.price };

  const seen = {};
  const cands = (market === 'domestic'
    ? ['KRX:' + code, 'KOSDAQ:' + code]
    : [OV_TICKER[code], code, 'NASDAQ:' + code, 'NYSEARCA:' + code, 'NYSE:' + code,
       'BATS:' + code, 'NYSEAMERICAN:' + code]
  ).filter(function (s) { if (!s || seen[s]) return false; seen[s] = true; return true; });

  const t = tmpSheet_('_tmpReg');
  t.clear();
  t.getRange(1, 1, cands.length, 2).setFormulas(cands.map(function (s) {
    return [priceFormula_(s), '=IFERROR(GOOGLEFINANCE("' + s + '","name"),"")'];
  }));
  let v = [];
  // GOOGLEFINANCE 는 비동기라 한 번에 안 채워질 수 있어 한 번 더 기다려 본다
  for (let tries = 0; tries < 2; tries++) {
    SpreadsheetApp.flush();
    Utilities.sleep(1500);
    v = t.getRange(1, 1, cands.length, 2).getValues();
    if (v.some(function (r) { return Number(r[0]) > 0; })) break;
  }
  t.clear();

  for (let i = 0; i < cands.length; i++) {
    const price = Number(v[i][0]) || 0;
    if (price <= 0) continue;
    const etf = market === 'domestic' ? naverEtfMap_()[code] : null;
    const name = clean_((etf && etf.itemname) || v[i][1], 40) || code;
    return { ok: true, code: code, symbol: cands[i], name: name, price: price };
  }
  return { ok: false, msg: '시세를 찾지 못했습니다. 종목코드를 다시 확인해주세요.' };
}

function registerAsset(userId, market, code, symbol, name) {
  needUser_(userId);
  market = mk_(market);
  code = normCode_(code);
  symbol = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9:.\-]{1,24}$/.test(symbol)) throw new Error('잘못된 요청입니다.');
  name = clean_(name, 40) || code;
  if (catalog_(market)[code]) return { ok: true };
  // appendRow 한 번으로 넣는다 — "=..."로 시작하는 값은 수식으로 들어가고, 동시에 두 명이
  // 등록해도 같은 행을 덮어쓰지 않는다.
  assetsSheet_().appendRow([market, txt_(code), txt_(name), txt_(name), symbol, priceFormula_(symbol)]);
  return { ok: true };
}

// ===== 계좌 (Accounts) =====
function acctsSheet_() { return sheet_('Accounts', AC_HEAD); }

function rowToAcct_(r, row) {
  let assets;
  // 깨진 데이터를 빈 구성으로 읽으면 다음 저장 때 보유수량이 통째로 지워진다 — 차라리 멈춘다
  try { assets = JSON.parse(String(r[9] || '[]')); }
  catch (e) { throw new Error('계좌 데이터가 손상되었습니다. 시트의 Accounts 탭을 확인해주세요.'); }
  return {
    row: row, userId: String(r[0]).trim(), id: String(r[1]).trim(), name: String(r[2]).trim(),
    market: mk_(r[3]), cash: Number(r[4]) || 0, dep: Number(r[5]) || 0, cum: Number(r[6]) || 0,
    peakNet: Number(r[7]) || 0, peakCum: Number(r[8]) || 0, assets: assets || [], created: r[10]
  };
}

function acctRow_(a) {
  return [txt_(a.userId), txt_(a.id), txt_(a.name), a.market, a.cash, a.dep, a.cum,
          a.peakNet, a.peakCum, JSON.stringify(a.assets), a.created || new Date()];
}

function writeAcct_(a) { acctsSheet_().getRange(a.row, 1, 1, AC_LAST).setValues([acctRow_(a)]); }

function acctsOf_(userId) {
  const sh = acctsSheet_(), last = sh.getLastRow(), out = [];
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, AC_LAST).getValues().forEach(function (r, i) {
    if (String(r[0]).trim() === userId) out.push(rowToAcct_(r, i + 2));
  });
  return out;
}

// 사용자의 계좌 목록. 하나도 없으면(= 이 버전 첫 로그인 또는 신규 가입) 예전 데이터를 옮겨
// 기본 계좌 두 개를 만든다. 원본 UserData 는 읽기만 한다 — 잘못돼도 원본이 그대로 남는다.
// 마지막 계좌는 지울 수 없게 막아두었으므로(deleteAcct) 이관이 두 번 돌 일은 없다.
function accountsFor_(userId) {
  let list = acctsOf_(userId);
  if (list.length) return list;
  needUser_(userId);
  assetsSheet_();   // 시트 생성(sheet_)도 락을 잡으므로, 락 안에서 또 잡지 않게 먼저 만들어 둔다
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    list = acctsOf_(userId);
    if (list.length) return list;
    migrateLegacy_(userId);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  return acctsOf_(userId);
}

function migrateLegacy_(userId) {
  const ud = udSheet_();
  const rows = ['domestic', 'overseas'].map(function (m) {
    const base = legacySheet_(m).getRange('A6:D' + (5 + LEGACY_N)).getValues();
    const r = findDataRow_(userId, m);
    const v = r === -1 ? null : ud.getRange(r, 1, 1, C_LAST).getValues()[0];
    const num = function (col) { return v ? Number(v[col - 1]) || 0 : 0; };
    const assets = [];
    base.forEach(function (b, i) {
      const code = String(b[1]).trim();
      if (!code) return;
      assets.push({ code: code, target: Number(b[2]) || 0, band: Number(b[3]) || 0,
                    shares: num(C_SHARES + i), below: v ? toDateStr_(v[C_BELOW - 1 + i]) : '' });
    });
    // id 를 'domestic'/'overseas' 로 두면 예전 Log 행(market 열)이 그대로 이 계좌 기록이 된다
    return acctRow_({ userId: userId, id: m, name: m === 'domestic' ? '국내 ISA' : '미국 직투',
      market: m, cash: num(C_CASH), dep: num(C_DEP), cum: num(C_CUM), peakNet: num(C_PEAK),
      peakCum: num(C_PEAKCUM), assets: assets, created: new Date() });
  });
  const sh = acctsSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, AC_LAST).setValues(rows);
}

// acctId 가 비어 있으면 첫 번째 계좌
function acct_(userId, acctId) {
  userId = String(userId || '').trim();
  const list = accountsFor_(userId);
  const id = String(acctId || '').trim();
  const a = id ? list.filter(function (x) { return x.id === id; })[0] : list[0];
  if (!a) throw new Error('계좌를 찾을 수 없습니다. 새로고침 해주세요.');
  a.list = list;
  return a;
}

function brief_(a) { return { id: a.id, name: a.name, market: a.market }; }

function addAcct(userId, name, market) {
  userId = String(userId || '').trim();
  const list = accountsFor_(userId);
  if (list.length >= MAX_ACCTS) throw new Error('계좌는 최대 ' + MAX_ACCTS + '개까지 만들 수 있습니다.');
  name = clean_(name, 20);
  if (!name) throw new Error('계좌 이름을 입력해주세요.');
  const id = 'a' + Date.now().toString(36);
  acctsSheet_().appendRow(acctRow_({ userId: userId, id: id, name: name, market: mk_(market),
    cash: 0, dep: 0, cum: 0, peakNet: 0, peakCum: 0, assets: [], created: new Date() }));
  return loadState(userId, id);
}

// spec = "코드:목표:밴드,코드:목표:밴드". 목표 합계가 정확히 100일 때만 저장한다.
// 남아 있는 종목의 보유수량·하단관찰일은 그대로 두고, 새로 넣은 종목은 0주로 시작한다.
function savePortfolio(userId, acctId, name, spec) {
  const a = acct_(userId, acctId);
  const cat = catalog_(a.market);
  const items = String(spec || '').split(',').filter(String).map(function (s) {
    const f = s.split(':');
    return { code: String(f[0]).trim(), target: Math.round(Number(f[1]) * 100) / 100,
             band: Math.round(Number(f[2]) * 100) / 100 };
  });
  if (!items.length) throw new Error('종목을 하나 이상 넣어주세요.');
  if (items.length > MAX_ASSETS) throw new Error('종목은 계좌당 최대 ' + MAX_ASSETS + '개까지입니다.');
  let sum = 0;
  const seen = {};
  items.forEach(function (x) {
    if (!cat[x.code]) throw new Error('등록되지 않은 종목입니다: ' + x.code);
    if (seen[x.code]) throw new Error('같은 종목이 두 번 들어 있습니다.');
    seen[x.code] = true;
    if (!(x.target > 0) || !(x.band >= 0) || x.target + x.band > 100) {
      throw new Error('비중 값이 올바르지 않습니다: ' + cat[x.code].short);
    }
    sum += x.target;
  });
  if (Math.abs(sum - 100) > 0.001) {
    throw new Error('목표 비중 합계가 100%가 아닙니다 (지금 ' + Math.round(sum * 100) / 100 + '%).');
  }
  const old = {};
  a.assets.forEach(function (p) { old[p.code] = p; });
  a.assets = items.map(function (x) {
    const o = old[x.code] || {};
    return { code: x.code, target: x.target, band: x.band,
             shares: Number(o.shares) || 0, below: o.below || '' };
  });
  const nm = clean_(name, 20);
  if (nm) a.name = nm;
  writeAcct_(a);
  return compute_(a, a.cash, a.dep, null, true);
}

function deleteAcct(userId, acctId) {
  const a = acct_(userId, acctId);
  if (a.list.length <= 1) throw new Error('마지막 계좌는 지울 수 없습니다.');
  acctsSheet_().deleteRow(a.row);
  SpreadsheetApp.flush();
  return loadState(userId, '');
}

// ===== 핵심 계산 =====
// persist=true 일 때만 하단관찰 시작일과 전고점을 시트에 기록한다.
function compute_(a, cashAsset, newDeposit, sharesMap, persist) {
  const cat = catalog_(a.market);
  const isKRW = a.market === 'domestic';
  const rnd = function (x) { return isKRW ? Math.round(x) : Math.round(x * 100) / 100; };

  let assets = [], total = 0;
  a.assets.forEach(function (p) {
    const c = cat[p.code] || {};
    const price = Number(c.price) || 0;
    const shares = Math.max(0, Math.floor(Number(sharesMap ? sharesMap[p.code] : p.shares) || 0));
    const amt = price * shares;
    total += amt;
    assets.push({
      name: c.name || p.code, code: p.code, short: c.short || c.name || p.code,
      usTicker: usTicker_(p.code),
      target: Number(p.target) || 0, band: Number(p.band) || 0,
      price: price, shares: shares, currentAmt: amt, adjAmt: 0, adjShares: 0
    });
  });

  // 총자산 = 종목 평가액 + 통장 현금 + 이번 신규 입금액.
  // 매도해도 이 값은 변하지 않으므로 모든 비율의 기준으로 쓴다.
  const cashPool = (Number(cashAsset) || 0) + (Number(newDeposit) || 0);
  const newTotal = total + cashPool;

  // ① 상단 초과분만 매도 — 상단선까지만 판다(목표까지 내리지 않음)
  let pool = cashPool;
  assets.forEach(function (x) {
    x.pct = newTotal > 0 ? x.currentAmt / newTotal * 100 : 0;
    x.upper = x.target + x.band;
    x.isOver = x.pct > x.upper;
    x.sellAmt = x.isOver ? x.currentAmt - newTotal * x.upper / 100 : 0;
    pool += x.sellAmt;
  });

  // ② 목표 대비 부족분에 비례 배분
  let sfSum = 0;
  assets.forEach(function (x) {
    x.shortfall = Math.max(newTotal * x.target / 100 - (x.currentAmt - x.sellAmt), 0);
    sfSum += x.shortfall;
  });
  assets.forEach(function (x) {
    const buy = sfSum > 0 ? pool * x.shortfall / sfSum
                          : pool * x.target / 100;   // 전부 목표 이상이면 목표 비중대로
    x.adjAmt = rnd(buy - x.sellAmt);
  });

  // 주식 수 (매수 내림 / 매도 올림, 보유량 초과 매도 방지)
  assets.forEach(function (x) {
    if (x.price <= 0) { x.adjShares = 0; return; }
    x.adjShares = x.adjAmt >= 0
      ? Math.floor(x.adjAmt / x.price)
      : Math.max(-Math.ceil(-x.adjAmt / x.price), -x.shares);
  });

  // 남는 현금으로 부족분 큰 쪽부터 1주씩 추가 매수
  let left = pool - spent_(assets);
  for (let g = 0; g < 500; g++) {
    let best = -1, bestSf = 0;
    assets.forEach(function (x, i) {
      if (x.price <= 0 || x.price > left || x.target <= 0) return;
      const sf = newTotal * x.target / 100 - (x.currentAmt + x.adjShares * x.price);
      if (sf > bestSf) { bestSf = sf; best = i; }
    });
    if (best < 0) break;
    assets[best].adjShares += 1;
    left -= assets[best].price;
  }

  // 하단 관찰 — 목표−밴드 아래로 내려간 시점 기록
  const td = today_();
  let below = [], dirty = false;
  a.assets.forEach(function (p, i) {
    const x = assets[i];
    let start = toDateStr_(p.below);
    const isBelow = x.pct < (x.target - x.band);
    if (isBelow && !start) { start = td; dirty = true; }
    if (!isBelow && start) { start = ''; dirty = true; }
    p.below = start;
    if (isBelow && start) below.push({ name: x.short || x.name, days: daysBetween_(start, td) });
  });

  // 전고점 · 최고 수익률 (순수 시장가치 = 총자산 − 누적 입금액)
  const netValue = newTotal - a.cum;
  if (a.cum > 0 && netValue > a.peakNet) {
    a.peakNet = netValue; a.peakCum = a.cum; dirty = true;
  }

  if (persist && dirty) writeAcct_(a);

  // 해외만 환율 조회 (평가금액 원화 환산 표시용)
  const fx = a.market === 'overseas' ? quoteOne_('CURRENCY:USDKRW') : 0;
  const noPrice = assets.filter(function (x) { return x.price <= 0; })
                        .map(function (x) { return x.short || x.code; });

  const s = spent_(assets), g2 = gained_(assets);
  return {
    userId: a.userId, market: a.market,
    account: brief_(a), accounts: (a.list || [a]).map(brief_),
    cashAsset: Number(cashAsset) || 0, newDeposit: Number(newDeposit) || 0,
    cumDeposit: a.cum,
    total: total, newTotal: newTotal, fx: fx,
    netValue: netValue,
    rate: a.cum > 0 ? netValue / a.cum * 100 : null,
    peakRate: a.peakCum > 0 ? a.peakNet / a.peakCum * 100 : null,
    assets: assets, below: below,
    spent: s, gained: g2, leftover: pool - s,
    priceWarning: noPrice.length ? '현재가가 조회되지 않은 종목이 있습니다: ' + noPrice.join(', ') : ''
  };
}

function spent_(a) {
  return a.reduce(function (t, x) { return t + (x.adjShares > 0 ? x.adjShares * x.price : 0); }, 0);
}
function gained_(a) {
  return a.reduce(function (t, x) { return t + (x.adjShares < 0 ? -x.adjShares * x.price : 0); }, 0);
}

// "코드:수량,코드:수량". 순서가 아니라 코드로 짝짓는다 — 다른 기기에서 구성을 바꾼 뒤
// 옛 화면으로 저장해도 엉뚱한 종목에 수량이 들어가지 않는다. 빠진 종목이 있으면 멈춘다.
// 콜론 없는 "12,5,0,3,1"은 예전 화면(배포 전환 중 캐시) 호환 — 구성 순서대로 짝짓는다.
function parseShares_(raw, a) {
  const s = String(raw || '').trim(), map = {};
  const parts = s ? s.split(',') : [];
  const stale = new Error('종목 구성이 바뀌었습니다. 새로고침 후 다시 해주세요.');
  const qty = function (v) { return Math.max(0, Math.floor(Number(v) || 0)); };
  if (parts.length && s.indexOf(':') === -1) {
    if (parts.length !== a.assets.length) throw stale;
    a.assets.forEach(function (p, i) { map[p.code] = qty(parts[i]); });
    return map;
  }
  parts.forEach(function (kv) {
    const i = kv.lastIndexOf(':');
    map[kv.slice(0, i).trim()] = qty(kv.slice(i + 1));
  });
  a.assets.forEach(function (p) { if (!(p.code in map)) throw stale; });
  return map;
}

// 저장된 상태 그대로 불러오기 (acctId 가 비면 첫 계좌)
function loadState(userId, acctId) {
  const a = acct_(userId, acctId);
  return compute_(a, a.cash, a.dep, null, true);
}

// 계산만 — 시트에 아무것도 쓰지 않음
function calcOnly(userId, acctId, cash, dep, sharesRaw) {
  const a = acct_(userId, acctId);
  return compute_(a, Number(cash) || 0, Number(dep) || 0, parseShares_(sharesRaw, a), false);
}

// 매매 완료 저장 — 실제 매매 내역(보유수량 변화)을 로그에 남기고 입력칸을 비운다
function saveState(userId, acctId, cash, dep, sharesRaw) {
  const a = acct_(userId, acctId);
  const after = parseShares_(sharesRaw, a);
  const cat = catalog_(a.market);
  const cashNow = Math.max(0, Number(cash) || 0);
  const depNow = Math.max(0, Number(dep) || 0);

  // 로그: 계산 예상치가 아니라 실제로 바뀐 보유수량 차이를 기록 (짧은 이름 사용)
  const parts = [];
  a.assets.forEach(function (p) {
    const d = after[p.code] - (Number(p.shares) || 0);
    if (d) {
      const c = cat[p.code] || {};
      parts.push((c.short || c.name || p.code) + ' ' + (d > 0 ? '매수 ' : '매도 ') + Math.abs(d) + '주');
    }
    p.shares = after[p.code];
  });

  // 저장: 보유수량은 입력값, 누적 원금은 가산, 현금·입금액 칸은 비움
  a.cum += depNow;
  a.cash = 0;
  a.dep = 0;
  writeAcct_(a);
  SpreadsheetApp.flush();
  appendLog_(a.userId, a.id, parts.length ? parts.join(', ') : '수량 변동 없음', cashNow, depNow);

  return compute_(a, 0, 0, null, true);
}

// ===== 로그 =====
// market 열에는 계좌 id 가 들어간다 (이관된 기본 계좌는 id 가 'domestic'/'overseas' 라 예전 행과 맞물림)
function logSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName('Log');
  if (!sh) {
    sh = ss.insertSheet('Log', ss.getSheets().length);
    sh.appendRow(['userId', 'market', 'date', 'summary', 'cash', 'deposit']);
  }
  return sh;
}

// 날짜를 문자열로 넣어 시트가 Date로 바꾸지 못하게 한다
function appendLog_(userId, acctId, summary, cash, deposit) {
  logSheet_().appendRow([userId, acctId, "'" + today_(), summary, cash || 0, deposit || 0]);
}

function getRecentLogs(userId, acctId) {
  const a = acct_(userId, acctId);
  const sh = logSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 6).getValues();
  const mine = rows.filter(function (r) {
    return String(r[0]).trim() === a.userId && String(r[1]).trim() === a.id;
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
function naverEtfMap_() {
  const map = {};
  try {
    const res = UrlFetchApp.fetch(
      'https://finance.naver.com/api/sise/etfItemList.nhn?etfType=0&targetColumn=market_sum&sortOrder=desc',
      { muteHttpExceptions: true, followRedirects: true, headers: {
        // User-Agent가 없으면 차단되는 경우가 있어 브라우저처럼 보내야 함
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://finance.naver.com/sise/etf.naver'
      } });
    if (res.getResponseCode() === 200) {
      const json = JSON.parse(res.getContentText('UTF-8'));
      ((json && json.result && json.result.etfItemList) || []).forEach(function (it) {
        map[String(it.itemcode).trim()] = it;
      });
    }
  } catch (e) { /* 실패하면 빈 목록 — 호출한 쪽이 "조회 안 됨"으로 표시 */ }
  return map;
}

// 해외 종목·국내 개별주식은 이 목록에 없으므로 -1(조회 안 됨) 처리.
function getAumInfo(userId, acctId) {
  const a = acct_(userId, acctId), cat = catalog_(a.market);
  const out = a.assets.map(function (p) {
    const c = cat[p.code] || {};
    return { name: c.name || p.code, short: c.short || '', code: p.code, aum: -1, gap: null };
  });
  if (a.market !== 'domestic' || !out.length) return out;

  const map = naverEtfMap_();
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
    const t = tmpSheet_('_tmpQuote');
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
// 이 방식이 훨씬 안정적이다. 실패한 종목은 null → 상위에서 GOOGLEFINANCE로 폴백.
function naverDailyReq_(code) {
  const endStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  const startD = new Date();
  startD.setDate(startD.getDate() - 400);
  const startStr = Utilities.formatDate(startD, 'Asia/Seoul', 'yyyyMMdd');
  return {
    url: 'https://api.finance.naver.com/siseJson.naver?symbol=' + encodeURIComponent(code) +
         '&requestType=1&startTime=' + startStr + '&endTime=' + endStr + '&timeframe=day',
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Referer': 'https://finance.naver.com/'
    }
  };
}

function parseNaverDaily_(res) {
  try {
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
      s.push({ d: new Date(Number(y), Number(m) - 1, Number(d)).getTime(), p: close });
    }
    if (s.length < 2) return null;
    s.sort(function (a, b) { return a.d - b.d; });
    return s;
  } catch (e) { return null; }
}

// 종목 수만큼 순서대로 부르지 않고 fetchAll 로 한꺼번에(병렬) 부른다
function fetchNaverDailyAll_(codes) {
  if (!codes.length) return [];
  try {
    return UrlFetchApp.fetchAll(codes.map(naverDailyReq_)).map(parseNaverDaily_);
  } catch (e) { return codes.map(function () { return null; }); }
}

// GOOGLEFINANCE 과거 시세를 종목마다 따로 기다리지 않고, 열을 나눠 한 번에 써서
// flush·대기를 한 번만 한다 — 종목이 몇 개든 기다리는 시간이 거의 같다.
// (국내 종목은 여기서 대부분 null — 하드 원 레슨 3번)
function fetchGoogleFinanceDailyBatch_(symbols) {
  const none = symbols.map(function () { return null; });
  if (!symbols.length) return none;
  try {
    const t = tmpSheet_('_tmpHist');
    t.clear();
    symbols.forEach(function (sym, k) {
      t.getRange(1, 1 + k * 2).setFormula('=GOOGLEFINANCE("' + sym + '","close",TODAY()-400,TODAY())');
    });
    let out = none;
    for (let tries = 0; tries < 2; tries++) {
      SpreadsheetApp.flush();
      Utilities.sleep(tries ? 2000 : 1500);
      out = readSeriesCols_(t, symbols.length);
      if (out.every(Boolean)) break;
    }
    t.clear();
    return out;
  } catch (e) { return none; }
}

function readSeriesCols_(t, n) {
  const last = t.getLastRow();
  const out = [];
  const raw = last >= 3 ? t.getRange(2, 1, last - 1, n * 2).getValues() : [];
  for (let k = 0; k < n; k++) {
    const s = [];
    raw.forEach(function (r) {
      const d = r[k * 2], p = r[k * 2 + 1];
      if (d instanceof Date && typeof p === 'number' && p > 0) s.push({ d: d.getTime(), p: p });
    });
    s.sort(function (a, b) { return a.d - b.d; });
    out.push(s.length >= 2 ? s : null);
  }
  return out;
}

// 시계열 하나 → 기간별 수익률 + 최근 1년 MDD
function returnsFrom_(x, s) {
  const out = { name: x.name, short: x.short, usTicker: x.usTicker, code: x.code, values: {}, mdd: null };
  ['1일', '1주일', '1개월', '6개월', '1년'].forEach(function (k) { out.values[k] = null; });
  if (!s || s.length < 2) { out.failed = true; return out; }

  const now = s[s.length - 1];
  [[1, '1일'], [7, '1주일'], [30, '1개월'], [182, '6개월'], [365, '1년']].forEach(function (pd) {
    const cut = now.d - pd[0] * 86400000;
    for (let k = s.length - 1; k >= 0; k--) {
      if (s[k].d <= cut) { out.values[pd[1]] = (now.p - s[k].p) / s[k].p * 100; return; }
    }
  });

  const yearAgo = now.d - 365 * 86400000;
  let peak = 0, mdd = 0, seen = false;
  s.forEach(function (q) {
    if (q.d < yearAgo) return;
    seen = true;
    if (q.p > peak) peak = q.p;
    if (peak > 0) mdd = Math.max(mdd, (peak - q.p) / peak * 100);
  });
  if (seen) out.mdd = -mdd;
  return out;
}

// 계좌의 모든 종목 수익률을 한 번에. 국내는 네이버 병렬 조회 → 실패분만 GOOGLEFINANCE 로 묶어 재시도.
function getReturns(userId, acctId) {
  const a = acct_(userId, acctId), cat = catalog_(a.market);
  const list = a.assets.map(function (p) {
    const c = cat[p.code] || {};
    return { code: p.code, name: c.name || p.code, short: c.short || '', usTicker: usTicker_(p.code),
             symbol: c.symbol || ticker_(a.market, p.code) };
  });
  const series = a.market === 'domestic'
    ? fetchNaverDailyAll_(list.map(function (x) { return x.code; }))
    : list.map(function () { return null; });
  const miss = [];
  series.forEach(function (s, i) { if (!s) miss.push(i); });
  if (miss.length) {
    const gf = fetchGoogleFinanceDailyBatch_(miss.map(function (i) { return list[i].symbol; }));
    miss.forEach(function (i, k) { series[i] = gf[k]; });
  }
  return list.map(function (x, i) { return returnsFrom_(x, series[i]); });
}

// ===== 진단용 (편집기에서 직접 실행) — Accounts 첫 번째 행의 계좌로 돌린다 =====
function firstAcct_() {
  const r = acctsSheet_().getRange(2, 1, 1, 2).getValues()[0];
  return [String(r[0]).trim(), String(r[1]).trim()];
}
function debugAum() {
  const f = firstAcct_();
  Logger.log(JSON.stringify(getAumInfo(f[0], f[1])));
}
function debugRet() {
  const f = firstAcct_();
  Logger.log(JSON.stringify(getReturns(f[0], f[1])));
}
