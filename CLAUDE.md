# ISA 5분할 리밸런싱 웹앱

국내 ISA 계좌 + 미국 직투 계좌용 5종목 ETF 동적 리밸런싱 계산기.
보유수량·현금을 입력하면 무엇을 얼마나 사고팔지 계산해준다.
매매는 시스템이 하지 않고, 계산 결과를 보고 사용자가 증권사 앱에서 직접 한다.

---

## 시스템 구조

```
[브라우저]
    ↓ 같은 사이트 요청이라 CORS 없음
[Vercel: isa-rebalancer.vercel.app]
    - index.html      저장소 루트, 화면 전체
    - api/proxy.js    서버 함수
    ↓ 서버 대 서버 호출
[Apps Script 웹앱]  /exec 로 끝나는 배포 주소
    - doGet(e) 하나가 라우터, action 파라미터로 분기
    ↓
[구글시트]  데이터베이스 역할
```

### 저장소 / 배포

| 항목 | 값 |
|---|---|
| GitHub | `ljh11-ui/isa-rebalancer` |
| Vercel | `https://isa-rebalancer.vercel.app` (GitHub push하면 자동 배포) |
| 시트 ID | `1vjteD7fGeJqRJwv4Xx6MwYgdnT6JbCl2ZSRQmj6ERfA` |
| Apps Script `/exec` | `https://script.google.com/macros/s/AKfycby4yW8EZymTsSWcmesbVHlFIYqotJHxDwiPoTc1ZxcMkzMTtJIQoCGvil-bA9gR4h-1Rw/exec` |

Apps Script 배포 설정은 **실행 = 나 / 액세스 권한 = 모든 사용자**여야 한다.
"Google 계정이 있는 모든 사용자"로 두면 Vercel 서버가 접근할 때 구글 로그인 페이지로
막혀서 프록시가 JSON 대신 HTML을 받는다. 과거에 이것 때문에 하루 날렸다.

### 구글시트 탭 구성

- **1번째 시트**: 국내 5종목 `A6:E10` (이름/코드/목표비중/밴드/현재가 수식)
- **Overseas**: 해외 5종목, 같은 구조 (티커/달러 현재가)
- **Users**: userId, pwHash, createdAt
- **UserData**: userId, market, cashAsset, newDeposit, shares1~5, cumDeposit,
  peakNetValue, peakCumDeposit, belowStart1~5 (17열)
- **Log**: userId, market, date, summary, cash, deposit (자동 생성)
- **_tmpQuote**: 시세 조회용 임시 시트 (숨김, 자동 생성)

---

## 포트폴리오 (5종, 각 목표비중 20%)

| 짧은 이름 | 종목명 | 국내코드 | 해외티커 | 상단밴드 |
|---|---|---|---|---|
| 나스닥 | TIGER 미국나스닥100 | 133690 | QQQ | 25% |
| S&P500 | KIWOOM 미국S&P500모멘텀 | 0137V0 | SPMO | 25% |
| 슈드 | TIGER 미국배당다우존스 | 458730 | SCHD | 25% |
| 배당퀄리티 | ACE 미국배당퀄리티 | 0046Y0 | DGRW | 25% |
| 미국 초단기채 | TIGER 미국달러SOFR금리액티브 | 456610 | SGOV | 23% |

**하단 밴드는 없다.** 목표보다 낮은 자산은 팔지도, 다른 자산을 팔아 채우지도 않는다.

### 운용 규칙 (핵심 로직)

1. **상단 초과분만 매도** — (목표+밴드)를 넘으면 넘은 만큼만 판다. 목표까지 내리지 않는다.
2. **부족분 비례 배분** — 매도대금 + 통장현금 + 신규입금액을 합쳐서, 목표보다 부족한
   자산들에 부족한 정도에 비례해 나눠 산다.
3. **금리 연동 규칙 없음** — 예전에 미국 기준금리 3단계 로직이 있었으나 전면 폐기됨.
   코드에 흔적이 남아있으면 안 된다.

---

## 파일별 역할

### `index.html` (약 1,200줄, 저장소 루트)

HTML + CSS + JS 한 파일. 프레임워크 없음, 순수 바닐라 JS.

주요 함수:

| 함수 | 역할 |
|---|---|
| `api(params, onOk, onErr)` | `/api/proxy`로 요청 보내는 공통 함수 |
| `doLogin()` / `doSignUp()` | 로그인 / 가입 |
| `enter(id)` / `doLogout()` | 로그인 화면 ↔ 메인 화면 전환 |
| `load()` | 저장된 상태 불러오기 (`action=load`) |
| `calc()` | 계산만, 시트에 안 씀 (`action=calc`) |
| `saveIt()` | 매매 완료 저장 (`action=save`) |
| `show(d)` | 계산 결과를 화면에 렌더링 |
| `loadAum(el)` | ETF 운용자산 규모 + 괴리율 (`action=aum`) |
| `loadLogs(el)` | 최근 기록, 항해일지 카드형 (`action=logs`) |
| `loadRet()` / `next()` / `render()` | 종목별 최근 수익률, 1종목씩 5번 호출 (`action=ret`) |
| `fmtDate(v)` | 서버가 어떤 형태로 날짜를 보내도 `yyyy-MM-dd`로 표시 |
| `lgOpenForm(mode)` / `lgCloseForm()` | 로그인 1단계(버튼 2개) ↔ 2단계(아이디·암호) 전환 |
| `lgSubmit()` | 2단계 제출 — mode에 따라 `doLogin()` 또는 `doSignUp()` 호출 |
| `lgPlayClip()` / `lgAfterClip(fn)` | 로그인 성공 시 진입 영상 재생, 끝난 뒤 콜백 |

### `Code.gs` (약 580줄, Apps Script)

| 함수 | 역할 |
|---|---|
| `doGet(e)` | 라우터. `action` 파라미터로 분기 |
| `compute_(...)` | 핵심 계산 로직. `persist=true`일 때만 시트에 기록 |
| `loadState` / `calcOnly` / `saveState` | 각각 load / calc / save 액션 처리 |
| `getAumInfo(market)` | 네이버 목록 API에서 순자산 + 괴리율 계산 |
| `getReturnOne(market, index)` | 종목 1개 수익률. 국내는 네이버, 해외는 GOOGLEFINANCE |
| `fetchNaverDaily_(code, days)` | 네이버 일별 종가 시계열 |
| `fetchGoogleFinanceDaily_(...)` | GOOGLEFINANCE 폴백 |
| `debugAum()` / `debugRet()` | 편집기에서 직접 실행하는 진단용 |

### `api/proxy.js` (Vercel 서버 함수)

브라우저 요청을 Apps Script `/exec`로 그대로 전달하고 응답을 돌려주는 역할만 한다.
`APPS_SCRIPT_URL` 상수가 최신 배포 주소와 일치해야 한다.

---

## 디자인 시스템

### 색상 (CSS 변수, `index.html` `:root`)

```css
--ink:#0b1d33        /* 잉크블루, 주 텍스트·강조 */
--ink-deep:#071426   /* 더 짙은 남색, 해외 탭 배경 */
--chart:#f5efe0      /* 해도지 크림, 페이지 배경 */
--paper:#fffdf6      /* 카드 배경 */
--brass:#b5713f      /* 황동, 액션·포인트 */
--brass-light:#e2b463
--slate:#33526f      /* 보조 링크·라벨 */
--fog:#7c8a9a        /* 흐린 보조 텍스트 */
```

매수는 빨강(`#dc2626`), 매도는 파랑(`#2563eb`) — 금융 관행이라 팔레트와 무관하게 유지.

### 폰트

- 큰 제목, 아코디언 헤더: **Fraunces** (세리프)
- 아코디언 안 상세 설명 본문: **Cormorant Garamond**
- 표·버튼·입력창 등 기능적 텍스트: 시스템 산세리프

### 화면 구성

**로그인 화면** — 항해 컨셉, 배경 영상 2개로 구성 (모바일 기준으로 디자인)
- 1단계: `assets/login1.mp4`(12.5초, 반복) 위에 "로그인하기" / "회원가입" 버튼 2개만
- 1단계 두 항목은 판때기 없이 글씨만 있다 (나눔손글씨 붓 26px/13px). 붓글씨체라 굵기가
  400 하나뿐이다 — `font-weight`를 올리면 가짜 볼드가 생기니 크기로만 존재감을 낸다.
  영상 위라 글자 그림자로 받치고,
  아래쪽 어둡게 까는 층(`.lgScrim`)이 대비를 만든다 — 둘 중 하나만 빼도 AA가 깨진다
- 2단계: 버튼을 누르면 아이디·암호 유리판이 떠오른다. mode에 따라 제출 버튼 문구만 바뀐다
- 3단계: 로그인 성공 → `assets/login2.mp4`(5초, 지도로 줌인) 재생 → 끝나면 페이드아웃으로 메인
- **화면 제목("그대들은 어떻게 투자할 것인가")은 영상 안에 이미 찍혀 있다.** HTML로 또 쓰면 겹친다
- 낮/밤 전환은 폐기됨 (영상이 1종이라 토글할 대상이 없다). `lgSetMode`·`DZ`·day.mp4/night.mp4 전부 제거

**비중 밴드** — 종목당 링 게이지 하나 (`renderBands`)
- 한 바퀴 = 0~30%. 다섯 링이 같은 자를 쓰므로 링끼리 바로 비교된다
- 트랙은 **상단 밴드에서 끊긴다**. 그 종목의 한계가 어디인지를 트랙 길이로 보여주는 게 핵심이라
  별도 마커가 없다. 트랙을 한 바퀴 다 그리면 이 디자인은 의미를 잃는다
- 진한 호 5색(`--g1`~`--g5`)은 디자인 핸드오프 원본 값이다. 종목의 신분증 색이라 바꾸지 않는다
- 트랙·여유 톤은 배경 대비 1.5~1.8:1로 낮다. 의도된 값이고, 실제 수치는 링 가운데 숫자가
  이미 말해주므로 정보가 사라지지 않는다 — 대비 올린다고 진하게 만들지 말 것
- 범례(0~20% 목표까지 / 여유 구간 / 진한 호 설명)는 뺐다. 다시 넣지 말 것

**메인 화면** — "해도 문서" 컨셉 (박스 최소화, 얇은 선·여백 위주)
- 카드 최상단 얇은 황동 그라디언트 띠
- 총자산은 박스 없이 큰 Fraunces 숫자 + 밑줄 구분선
- 표는 헤더 밑줄(2px) + 짝수 행 옅은 황동 줄무늬
- 버튼은 알약(pill) 모양. 계산하기는 아웃라인, 매매완료는 황동 채움
- 아코디언은 박스 없이 밑줄 구분선만, 호버 시 황동색

### 아코디언 순서

종목별 최근 수익률 → 최근 기록 → 운용 규칙 → ETF 운용자산 규모 → 종목 상세 설명

---

## 하드 원 레슨 (같은 실수 반복 금지)

### 1. Apps Script 재배포 규칙

코드를 고칠 때마다: **저장 → 배포 관리 → 기존 활성 배포 선택 → 연필 → 버전 "새 버전" → 배포**

"새 배포"를 새로 만들면 `/exec` 주소가 바뀌어서 `api/proxy.js`도 같이 고쳐야 한다.
**절대 새 배포를 만들지 말 것.**

### 2. `UrlFetchApp` 권한 승인

외부 URL 접근(`script.external_request`) 권한이 승인 안 되면 `UrlFetchApp.fetch`가
전부 예외를 던지는데, `try/catch`가 이걸 삼켜서 조용히 `null`만 나온다.
편집기에서 함수를 직접 실행해 권한 팝업을 한 번 승인해야 한다.

팝업이 안 뜨면: `myaccount.google.com/permissions`에서 해당 프로젝트 액세스 권한을
삭제한 뒤 다시 실행하면 새로 승인 화면이 뜬다.

### 3. GOOGLEFINANCE는 국내 종목 과거 시세를 못 가져온다

현재가는 되는데 `GOOGLEFINANCE(...,"close",...)` 방식의 과거 일별 시세는 국내 종목에서
계속 `null`이 나온다. 그래서 `fetchNaverDaily_`로 네이버 공개 API를 쓴다.
해외 종목은 GOOGLEFINANCE가 잘 되므로 그대로 둔다.

네이버 응답은 진짜 JSON이 아니라 작은따옴표 쓰는 JS 배열 리터럴이라, 따옴표를 바꾸고
후행 쉼표를 지운 뒤 파싱해야 한다.

### 4. 괴리율은 종목 페이지를 긁지 말 것

`finance.naver.com/item/main.naver` 페이지에는 "괴리율" 문자열이 더 이상 없다.
대신 AUM 조회에 쓰는 `etfItemList.nhn` 응답에 `nowVal`(현재가)과 `nav`(순자산가치)가
이미 들어있으므로 `(nowVal - nav) / nav * 100`으로 직접 계산한다.

### 5. 로그 날짜가 "Mon Aug 17"로 나오던 문제

구글시트가 날짜 문자열을 자동으로 Date 객체로 바꿔버려서 생긴다.
`appendLog_`에서 앞에 `'`를 붙여 문자열로 저장하고, 프론트에서도 `fmtDate()`로 한 번 더
방어한다.

### 6. 로그인 배경 영상은 압축해서 넣는다

원본은 1080x1920 / 5.5~9.0Mbps라 둘이 14MB였다. 모바일에서 첫 방문이 느려진다.
해상도는 그대로 두고 비트레이트만 낮추면 화질 차이 없이 줄어든다:

```
ffmpeg -i 원본.mp4 -an -c:v libx264 -preset slow -crf 28 \
       -pix_fmt yuv420p -movflags +faststart assets/login1.mp4
```

`-an`(소리 제거)과 `-movflags +faststart`(스트리밍 시작 빠르게)를 빠뜨리지 말 것.
현재 login1은 CRF 28(2.0MB), login2는 CRF 26(1.6MB). 영상을 갈아끼우면 `sw.js`의
`CACHE_NAME` 버전도 올려야 기존 방문자의 옛 캐시가 지워진다.

### 7. CORS

Vercel에서 Apps Script를 직접 fetch하면 CORS에 막힌다. JSONP도 시도했으나 실패.
현재 구조(서버 함수 프록시)가 최종 해결책이다.

---

## 검증 안 된 것 / 남은 일

### 검증 필요
- 하단 관찰 배너 — 이탈 자산 없을 때 안 보이는지, 있을 때만 뜨는지
- 최근 기록의 매매 수량이 실제 보유수량 diff와 일치하는지

### 미착수 (나중으로 미룸)
- 종목·비중 자유 설정 페이지
- 배당 정보(배당월 + 참고 배당수익률) 표시
- 해외 계좌 출금 이력 추적
- Vercel 프로젝트 이름(= URL) 변경 — Settings > General > Project Name

### 폐기 결정된 것 (다시 꺼내지 말 것)
- 이메일 알림 — 자동 발동 시스템이 아니라 의미 없음
- 하단 이탈 시 다른 자산 팔아 채우는 규칙 — 효과 대비 원칙 훼손 리스크가 커서 기각
- 미국 기준금리 3단계 연동 — 완전 폐기
- 나스닥 주간수익률 연동 바다 무드 스트립 — 만들었다가 제거함

---

## 로컬 개발 시작하기

```bash
git clone https://github.com/ljh11-ui/isa-rebalancer.git
cd isa-rebalancer
claude
```

`index.html`은 로컬에서 그냥 브라우저로 열어도 화면은 보이지만, `/api/proxy`가 없어서
로그인은 안 된다. 실제 동작 확인은 GitHub push 후 Vercel 배포본에서 한다.

`Code.gs`는 Apps Script 편집기에 붙여넣는 방식으로 관리 중이다.
`clasp`를 쓰면 로컬에서 배포까지 가능하지만 아직 도입 안 함.

---

## 작업 시 지켜야 할 것

- 파일(문서, 코드)을 고치기 전에 **수정 방향을 먼저 정리해서 물어보고**, 진행하라는
  답이 있어야 실제로 고친다.
- 기능 로직(계산, 저장, 로그인)은 디자인 작업 중에 건드리지 않는다.
- 매수 빨강 / 매도 파랑은 금융 관행이므로 디자인 톤 통일한다고 바꾸지 않는다.
