# 편성표(스케줄) — 구현 계획

작성: 2026-10-02 · 상태: **계획**(코드 없음)

출발점은 2026-09-30 대화의 제안이다. 거기서 정한 것을 그대로 잇는다.
- 두 종류로 나눈다: **대형**(멸망전·이벤트 대회 — 확정 편성, 여러 날)과 **소형**(CK·간단한 매치 — 예고, 무산될 수 있음)
- 주최는 공식 채널이 아니라 **스트리머 본인**이다. 대형과 소형의 출처는 똑같이 스트리머 방송국이다
- 대회 하나에 공지가 여러 개 붙는다(개최 → 모집 → 조 편성 → 일정 변경)
- 매치·대회만 올린다. 토크 같은 특집 방송은 넣지 않는다

**이번 결정(2026-10-02):** 게시판 표본 조사와 자동 수집은 미룬다. **사람이 입력하는 편성표**를 먼저 만든다.
자동 수집은 나중에 붙이고, 수집 결과도 같은 입력 경로(관리자 확정)로 들어오게 한다.

---

## 1. 화면 형태

### 이름

- **간트 차트(Gantt chart)** 또는 **타임라인 뷰**: 가로축이 날짜이고, 일정마다 기간만큼 긴 막대를 그린다
- **EPG 그리드**(Electronic Program Guide): TV 편성표 형태. 행이 채널, 가로축이 하루 안의 시각이다

### 무엇을 고르나 → 위는 간트, 아래는 날짜 칸

| 형태 | 잘 맞는 경우 | 이 사이트에서 |
|---|---|---|
| EPG(행=채널, 축=시각) | 채널이 많고 하루가 빽빽함 | 하루에 일정이 몇 개뿐이라 대부분 빈칸이다 |
| 간트(행=일정, 축=날짜) | 여러 날 이어지는 일정 | 대형 대회에 딱 맞다. 하루짜리 CK는 점 하나가 된다 |
| 달력 칸(날짜 칸에 카드 쌓기) | 하루짜리가 많음 | 소형에 맞다 |

그래서 둘을 합친다. 구글 캘린더 주간 보기에서 위쪽에 "종일 막대"가 있는 모양이다.

```
 ◀ 10/1 ~ 10/14 ▶                       [롤|FC] [대형|소형] [스트리머 ▾]
          10/1  10/2  10/3  10/4  10/5  10/6  10/7 …
                 ┊오늘
대형 ───────────────────────────────────────────────────────
2026 멸망전 S2  ███━━━━███━━━━███━━━━━━━━━━━━━███▶   주최 ○○ · 후원 ○○
 (조별 1·2일차·8강·…)    ↑ 진한 칸 = 경기 있는 날, 가는 선 = 대회 기간
○○배 FC 대회           ██████                       주최 ○○
소형 ───────────────────────────────────────────────────────
                 ┊ 20:00       19:00
                 ┊ ░김민교 CK░  ░A vs B░
                 ┊ 모집 중      진행 ✓
                 ┊ 21:00
                 ┊ ~~○○ CK~~ 무산
```

- **대형**: 일정 하나가 한 줄이다. 대회 기간 전체에 가는 선을 긋고, 실제 경기 날짜만 진하게 칠한다. 칸 위에 마우스를 올리면 그날의 단계(조별 2일차 등)를 보여준다
- **소형**: 그날 칸 안에 시각 순서대로 카드를 쌓는다. 연한 색에 "예고" 뱃지를 달고, 진행이 확인되면 진한 색, 무산되면 취소선
- **오늘** 세로선을 긋고, 지금 진행 중인 칸은 "LIVE"로 표시한다
- **기간**: 기본 14일(오늘 기준 앞뒤). `?from=2026-10-01`로 이동한다
- **휴대폰**(좁은 화면): 간트를 버리고 날짜별 목록으로 바꾼다. 대형은 "진행 중인 대회" 띠로 맨 위에 고정한다
- **차트 라이브러리는 쓰지 않는다.** CSS grid로 날짜 칸을 만들고 `grid-column: 시작 / 끝`으로 막대를 그린다. 배치 계산(어느 칸부터 어느 칸까지, 카드 순서)은 순수 함수로 두고 테스트한다

EPG(하루 시각 축)는 하루 일정이 빽빽해지면 그때 "하루 보기"로 추가한다. 처음부터 만들지 않는다.

### 상세 (`/schedule/[id]`)

- 일정 칸 목록: 날짜·시각·단계·중계 채널
- 참가 스트리머(프로필 링크), 주최, 후원
- **관련 공지를 시간순으로**: 공지만 모아 봐도 대회가 어떻게 흘러갔는지 보인다
- 끝난 대회는 결과(대회 페이지)로 연결한다

---

## 2. 데이터 모델

### 왜 `event`에 바로 넣지 않나

`event`는 **실제로 열린 것**의 기록이다. 경기와 조우가 여기에 매달린다. 예고만 하고 안 연 CK를 `event`에 넣으면 공개 화면에 거짓이 나간다. `event_lead`(0012)를 따로 둔 것과 같은 이유다.
그래서 편성은 **별도 표**에 두고, 실제로 열려서 `event`가 생기면 `event_id`로 **연결만** 한다.

### 표 (마이그레이션 0056, 가칭)

```sql
-- 편성 하나 = 대회 하나 또는 하루짜리 매치 하나
CREATE TABLE schedule_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_code   text NOT NULL CHECK (game_code IN ('lol','fconline')),
  title       text NOT NULL,                    -- '2026 멸망전 시즌2', '김민교 추석 CK'
  scale       text NOT NULL CHECK (scale IN ('major','minor')),          -- 대형·소형. 사람이 정한다
  kind        text NOT NULL CHECK (kind IN ('tournament','showmatch','ck','other')), -- event.kind 와 같은 어휘
  sponsor     text,
  status      text NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled','held','cancelled')),     -- 예정 / 진행 확인 / 무산
  event_id    uuid REFERENCES event(id) ON DELETE SET NULL,            -- 실제 열린 기록과 연결
  origin      text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual')), -- 자동 수집이 붙으면 값을 늘린다
  visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','hidden')),
  note        text,
  created_at, updated_at
);

-- 실제로 방송하는 칸. 대형은 여러 개, 소형은 보통 하나
CREATE TABLE schedule_slot (
  id          uuid PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  label       text,                              -- '조별 1일차', '결승'
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz CHECK (ends_at IS NULL OR ends_at > starts_at),
  time_known  boolean NOT NULL DEFAULT true,     -- false 면 날짜만 안다(starts_at = KST 자정). "시각 미정"으로 표시
  channel_id  text                               -- 중계 채널(SOOP 방송국 아이디). 없으면 주최 채널
);

-- 누가 나오나. 주최도 여기서 role 로 표시한다 (주최 칸을 따로 두지 않는다)
CREATE TABLE schedule_participant (
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  streamer_id uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('host','player','caster')),
  team        text,
  PRIMARY KEY (entry_id, streamer_id, role)
);

-- 근거 공지. 대회 하나에 여러 개
CREATE TABLE schedule_source (
  id          uuid PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  url         text NOT NULL,
  title       text,
  posted_at   timestamptz,                       -- 공지 작성 시각. 상세의 공지 시간순 정렬에 쓴다
  UNIQUE (entry_id, url)
);
```

### 정한 것과 이유

- **"진행 중"·"종료"·"확인 안 됨"은 저장하지 않는다.** 지금 시각과 칸 시각에서 계산한다. 저장하면 매일 누가 바꿔 줘야 한다
  - `cancelled` → 무산(취소선)
  - 지금이 칸 시간 안 → 진행 중
  - 지나갔고 `held` → 종료(`event`가 있으면 결과 링크)
  - 지나갔는데 `scheduled` → 대형은 "종료(공지 기준)", 소형은 **"확인 안 됨"**. 소형은 무산될 수 있으므로 열렸다고 단정하지 않는다
  - 이 계산은 공개 화면·관리자·나중의 ICS가 모두 쓰므로 `packages/core/lib/metrics/schedule.ts` 하나에 둔다(코딩 원칙 6)
- **주최를 참가자 역할로 둔다.** 주최 칸을 따로 두면 "주최가 선수로도 나온다" 같은 경우에 두 곳을 맞춰야 한다
- **등록 스트리머만 참가자로 연결한다.** 미등록 참가자는 `note`에 글로 적는다. `core_public`이 일반인을 걸러 내는 원칙과 같다
- **공개하려면 근거 공지가 최소 1개 있어야 한다.** 표 사이 조건이라 CHECK로는 못 건다. 공개 뷰가 근거 없는 편성을 내보내지 않고, `verify:db`가 이를 확인한다
- **수기 뱃지**(원칙 8): 지금은 전부 수기다. `origin`을 처음부터 두어서, 자동 수집이 붙었을 때 화면에서 구분할 수 있게 한다
- **변경 이력은 2단계에서 붙인다.** "10/5 → 10/6 연기" 표시와 변경 알림에 필요하다. 0042 `review_change`처럼 같은 트랜잭션에서 전후 값을 남긴다

### 공개 경계

- `core_public.schedule_*` 뷰를 만든다. 숨긴 편성, 숨긴 스트리머가 들어간 참가 행, 근거 없는 편성을 거른다
- 계약(`core/lib/contract`)에 `listPublicSchedule({ from, to, game })`와 `getPublicScheduleEntry(id)`를 추가한다

---

## 3. 어디에 두나

| 부분 | 위치 | 이유 |
|---|---|---|
| 표·쓰기 접근자 | core (`db/migrations/0056`, `core/lib/db/schedule.ts`) | 편성은 **사실**(무엇이 언제 예고됐나)이다. core가 사실을 소유한다 |
| 상태 계산 | `core/lib/metrics/schedule.ts` | 여러 화면이 같은 함수를 쓴다 |
| 관리자 입력 | `apps/web/app/admin/schedule` | 관리자 화면은 전부 core 웹에 있다 |
| 공개 편성표 | **플랫폼 모듈 `packages/modules/schedule`** (`"game": "platform"`, `/schedule`, `/schedule/[id]`) | 정책과 화면이다. 떼어 낼 수 있어야 한다. 자기 표가 없으므로 `migrations/`도 잡도 없다(대회 모듈과 같은 모양) |
| 결과 연결 | 편성의 게임에 맞는 역할로 링크: 롤 `roleHref("tournaments", { slug })`, FC `roleHref("fc-tournaments", { slug })` | 모듈끼리 import 하지 않는다(계약 3조) |

**어느 사이트에 뜨나 (2026-10-02 결정):** 편성표는 게임 층이 아니라 **플랫폼 층(로비)**에 둔다.
주소는 `/schedule` 하나이고, 롤·FC 사이트 머리말에도 메뉴가 뜬다. 거기서 들어오면 `?game=lol` 같은 필터가 걸린다.
로비를 먼저 만들어야 한다 — [PLATFORM-LAYER-PLAN.md](PLATFORM-LAYER-PLAN.md) 1~3단계가 이 계획의 선행 작업이다.

---

## 4. 관리자 입력 (`/admin/schedule`)

- **목록**: 다가오는 일정 / 지난 일정 탭. 지난 소형 중 `scheduled`로 남은 것("확인 안 됨")을 위에 올린다. 이걸 `held`나 `cancelled`로 정리하는 게 일상 작업이다
- **입력 폼** (한 화면, 저장은 한 번)
  1. 기본: 게임 · 제목 · 대형/소형 · 종류 · 후원 · 메모
  2. 일정 칸: 행 추가 방식으로 날짜 · 시작 · 끝 · 단계 · "시각 미정" 체크 · 중계 채널. 대형은 **"매일 같은 시각으로 N일 추가"** 버튼을 둔다(조별 리그 입력용)
  3. 참가자: 스트리머 검색 선택 + 역할(주최/선수/해설) + 팀
  4. 근거 공지: URL · 제목 · 작성 시각. 1개 이상 필수
  5. 상태 버튼: 진행 확인 / 무산 / 되돌리기. 실제 `event`가 있으면 골라서 연결한다
- 시각 입력은 KST로 받는다. `toKstInputValue`·`fromKstInputValue`(core/lib/time.ts)를 쓴다
- URL만 붙이면 자동으로 채우는 기능(게시판 글을 읽어 오는 것)은 **넣지 않는다.** 그건 자동 수집 단계의 일이다

---

## 5. 단계

| 단계 | 내용 | 끝났다는 기준 |
|---|---|---|
| **1. 수기 편성표 MVP** | 0056 스키마 + 공개 뷰 · 쓰기 접근자 · 상태 계산 · 관리자 입력 · `/schedule` 간트+목록 | 멸망전 하나와 CK 몇 개를 손으로 넣고 화면에서 확인 |
| 2. 상세와 이력 | `/schedule/[id]`(공지 시간순) · 변경 이력 · 스트리머 프로필에 "다가오는 일정" | 일정을 미루면 이력과 함께 표시 |
| 3. 알림 | **캘린더 구독(ICS)**: `/schedule.ics`, 스트리머별 `?s=slug`. 구글 캘린더가 알림을 대신 준다. 운영자용 디스코드 웹훅은 선택 | 구글 캘린더에 구독해서 일정이 뜸 |
| 4. 자동 수집 | 게시판 표본 조사(9/30 계획) → 와치리스트 새 글 수집 → **후보 목록** → 관리자가 1단계 폼에 채워진 상태로 확정 | 수집 후보가 쌓이고, 확정하면 편성표에 뜸 |
| 5. CK 조사 연결 | 끝난 소형 일정의 참가자 VOD를 CK 조사 큐 앞에 넣고, 결과 `event`와 자동 연결 | 일정 → 조사 → 결과가 이어짐 |

ICS는 웹 페이지가 아니라 파일 응답이다. 모듈은 지금 페이지만 띄울 수 있으므로(`app/[...path]`), core 라우트(`app/schedule.ics/route.ts`)로 둘지 모듈 manifest에 파일 경로를 추가할지는 3단계에서 정한다.

---

## 6. 검증

- `npm test`: 상태 계산(경계 시각, 시각 미정, 무산, 대형/소형 차이), 간트 배치 계산(기간 밖으로 잘림, 여러 날, 같은 날 카드 순서)
- `npm run verify:db`: 0056이 올라가는지, 공개 뷰가 숨긴 편성·숨긴 스트리머·근거 없는 편성을 거르는지, `ends_at <= starts_at`이 거부되는지
- `npm run verify:modules`: 모듈이 계약과 `core_public`만 읽는지
- 화면: 실제 DB로 `/schedule`을 띄워 넓은 화면과 휴대폰 너비에서 확인

---

## 7. 정할 것

1. **공개 범위**: 1단계부터 공개 메뉴에 띄울지, 관리자만 보는 상태로 시작할지
2. **알림 수단**(3단계): ICS 구독만으로 충분한지, 디스코드 웹훅도 필요한지

~~FC 사이트에도 띄울지~~ → 2026-10-02 결정: 플랫폼 층에 두고 두 사이트 모두에서 들어간다(§3).
