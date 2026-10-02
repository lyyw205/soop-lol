# 편성표(스케줄) — 구현 계획

작성: 2026-10-02 · 개정: 2026-10-02(외부 검토 반영) · 상태: **1·2단계 검증 완료**(2026-10-02, 마이그레이션 0056·0057 운영 DB 적용) · 3단계(개별 알림)는 로그인 이후 별도 계획
선행 작업: [PLATFORM-LAYER-PLAN.md](PLATFORM-LAYER-PLAN.md) 2단계(롤 이동 + 최소 로비)

> ⚠ **폐기된 결정**(이 문서의 이전 판)
> - ~~`schedule_slot.time_known` + 시각 미정이면 `starts_at` 에 KST 자정을 넣는다~~ → 지어낸 자정이 진행 판정과 표시에 새어 나간다.
>   날짜와 시각을 **따로 저장**하고 시각은 비워 둔다(§2).
> - ~~진행 중인 칸을 "LIVE" 로 표시한다~~ → 실제 방송 상태를 보지 않는다. **"공지상 진행 시간"** 으로 쓴다.
> - ~~지난 대형 일정은 "종료(공지 기준)" 으로 자동 표시한다~~ → 시간이 지난 것과 실제로 열린 것은 다르다. 대형도 사람이 `held` 로 확인한다.
> - ~~결과 링크: 롤 `roleHref("tournaments", {slug})`~~ → 롤 대회 상세는 `kind='tournament'` 만 연다. CK·이벤트전으로 링크하면 404 다(§2 결과 연결).
> - ~~`note` 한 칸~~ → 공개 설명과 관리자 메모를 나눈다.
> - ~~`"game": "platform"`~~ → 공간 구분은 `site` 칸이다. 일정의 게임 값에 `platform` 은 없다.

## 출발점 (2026-09-30 대화에서 정한 것)

- 두 종류: **대형**(멸망전·이벤트 대회 — 확정 편성, 여러 날)과 **소형**(CK·간단한 매치 — 예고, 무산될 수 있음)
- 주최는 공식 채널이 아니라 **스트리머 본인**이다. 대형·소형 모두 출처는 스트리머 방송국이다
- 대회 하나에 공지가 여러 개 붙는다(개최 → 모집 → 조 편성 → 일정 변경)
- 매치·대회만 올린다. 토크 같은 특집 방송은 넣지 않는다

## 결정된 것 (2026-10-02)

- **사람이 입력하는 편성표를 먼저 만든다.** 게시판 조사·자동 수집은 미룬다. 나중에 붙여도 같은 저장 경로(관리자 확정)를 쓴다
- **게임은 롤·FC 둘만.** `game_code IN ('lol','fconline')`. 다른 게임은 그 게임을 추가할 때 함께 넓힌다
- **공간은 플랫폼(로비)**: `/schedule` 하나. 롤·FC 머리말에서 들어오면 `?game=` 필터가 걸린다
- **초안·승인 단계는 두지 않는다.** 관리자 저장 시 서버가 검증하고 전체를 원자적으로 저장한다

---

## 1. 화면

### 형태 — 위는 간트, 아래는 날짜 칸

- **간트 차트**(행 = 일정, 가로축 = 날짜): 여러 날 이어지는 대형에 맞다
- **날짜 칸**(그날 칸에 카드 쌓기): 하루짜리 소형에 맞다
- **EPG 그리드**(행 = 채널, 축 = 하루 시각)는 하루가 빽빽하지 않아 대부분 빈칸이다 → 만들지 않는다(후속)

```
 ◀ 10/1 ~ 10/14 ▶                         [전체|롤|FC] [전체|대형|소형] [스트리머 ▾]
          10/1  10/2  10/3  10/4  10/5  10/6  10/7 …
                 ┊오늘
대형 ───────────────────────────────────────────────────────
2026 멸망전 S2  ███━━━━███━━━━███━━━━━━━━━━━━━███▶   주최 ○○ · 후원 ○○
○○배 FC 대회           ██████                       주최 ○○
소형 ───────────────────────────────────────────────────────
                 ┊ 20:00       시각 미정
                 ┊ ░김민교 CK░  ░A vs B░
                 ┊ 예고         개최 확인 ✓
                 ┊ ~~○○ CK~~ 무산
```

- 대형: 행사 기간(첫 칸 날짜 ~ 마지막 칸 날짜)에 가는 선, 실제 방송 칸이 있는 날만 진하게
- 소형: 그날 칸 안에 카드. 시각 있는 것을 먼저 시각순, 시각 미정은 그 뒤
- 휴대폰(좁은 화면): 날짜별 목록. 대형은 "진행 중인 행사" 띠로 맨 위
- 차트 라이브러리 없이 CSS grid. 배치 계산은 순수 함수로 두고 테스트한다
- 키보드: 카드·막대는 링크나 버튼으로 만들어 Tab 으로 이동할 수 있게 한다

### 상태 문구 — 시간이 지난 것과 실제로 열린 것을 나눈다

| 저장된 상태 | 지금 시각 | 표시 |
|---|---|---|
| `cancelled` | 무관 | **무산** (취소선) |
| `scheduled`/`held` | 시작 전 | 예정 (소형은 "예고" 뱃지) |
| `scheduled`/`held` | 시작 ≤ 지금 < 끝 | **공지상 진행 시간** |
| `scheduled` | 끝(또는 그날) 지남 | **지난 일정 · 개최 미확인** |
| `held` | 끝 지남 | **개최 확인** (결과 링크는 §2 조건일 때만) |

- **시각 미정**(날짜만 앎): 진행 판정을 하지 않는다. 그날이 지나면 "지난 일정"
- **종료 미정**(시작만 앎): "공지상 진행 시간" 을 쓰지 않는다. 시작 후에는 "HH:MM 시작" 그대로, 그날(KST)이 지나면 "지난 일정"
- 상태는 **서버가 렌더한 시각** 기준이다. 화면에 "MM/DD HH:MM 기준" 을 적고 자동 갱신은 하지 않는다(후속)
- 이 계산은 `core/lib/metrics/schedule.ts` 하나에 둔다(원칙 6). 공개 화면·관리자가 같은 함수를 쓴다

### 결과·상세 링크

- 결과 링크는 **열리는 화면이 확실할 때만** 그린다(§2 결과 연결). 모듈이 있다는 것만으로 링크하지 않는다
- 상세 화면(`/schedule/[id]`)은 후속 단계다. **1단계 카드에는 상세 링크를 만들지 않는다.** 카드를 누르면 같은 화면 안에서 펼침(일정 칸·참가자·출처)

---

## 2. 데이터 모델 (마이그레이션 번호는 만들 때 장부로 확인)

### 왜 `event` 에 바로 넣지 않나

`event` 는 **실제로 열린 것**의 기록이다. 예고만 하고 안 연 CK 를 넣으면 공개 화면에 거짓이 나간다(`event_lead` 와 같은 이유).
편성은 별도 표에 두고, 실제로 열려 `event` 가 생기면 **연결만** 한다.

### 표

```sql
CREATE TABLE schedule_entry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_code    text NOT NULL CHECK (game_code IN ('lol','fconline')),
  title        text NOT NULL,
  scale        text NOT NULL CHECK (scale IN ('major','minor')),            -- 대형·소형. 사람이 정한다
  planned_kind text NOT NULL CHECK (planned_kind IN ('tournament','showmatch','ck','other')), -- 공지 기준 분류
  sponsor      text,
  description  text,                                                       -- 공개 설명
  admin_note   text,                                                       -- 관리자 메모. 공개 뷰에 없다
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','held','cancelled')),
  event_id     uuid REFERENCES event(id) ON DELETE SET NULL,
  origin       text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual')),
  visibility   text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','hidden')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NULL OR status = 'held')                              -- 무산·미확인 일정에 결과를 달지 않는다
);

CREATE TABLE schedule_slot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  label       text,                                -- '조별 1일차', '결승'
  on_date     date NOT NULL,                       -- KST 날짜. 언제나 안다
  starts_at   timestamptz,                         -- 모르면 NULL (자정을 지어내지 않는다)
  ends_at     timestamptz,                         -- 모르면 NULL
  channel_id  text,                                -- 중계 채널(SOOP 방송국 아이디). 명시값
  CHECK (starts_at IS NULL OR (starts_at AT TIME ZONE 'Asia/Seoul')::date = on_date),
  CHECK (ends_at IS NULL OR (starts_at IS NOT NULL AND ends_at > starts_at))
);

CREATE TABLE schedule_participant (
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  streamer_id uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('host','player','caster')),   -- 주최도 역할 하나
  team        text,
  PRIMARY KEY (entry_id, streamer_id, role)
);

CREATE TABLE schedule_source (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  url         text NOT NULL,
  title       text,
  posted_at   timestamptz,
  UNIQUE (entry_id, url)
);
```

행사 기간(대형 막대)은 저장하지 않는다. 칸들의 `on_date` 최소~최대에서 계산한다.

### 저장 계약 — 쓰기는 접근자 하나 (`core/lib/db/schedule.ts` 의 `saveScheduleEntry`)

1. **원자적 저장**: 본문·칸·참가자·출처를 한 트랜잭션에서 통째로 바꾼다. 하나라도 실패하면 아무것도 안 바뀐다
2. **서버 검증**(폼 검증과 별개로 접근자가 다시 한다)
   - 날짜·시각은 실제 달력에 있는 값만(`fromKstInputValue` 는 2026-10-02 에 없는 날짜를 거부하도록 고쳤다)
   - 칸이 1개 이상, 끝 > 시작, 시작 시각의 KST 날짜 = 칸 날짜(DB CHECK 와 이중)
   - **공개(`visibility='public'`)로 저장하려면 출처가 1개 이상**
   - `event_id` 를 걸면: `status='held'` 여야 하고, **`event.game_code = entry.game_code`** 여야 한다
   - 연결된 상태에서 `game_code` 를 바꾸려 하면 거부한다. 연결을 먼저 끊어야 한다
3. **동시 수정**: 폼이 열 때 받은 `updated_at` 을 같이 보낸다. DB 값과 다르면 저장을 거부하고 "다른 수정이 먼저 저장됐다" 를 돌려준다. 덮어쓰지 않는다
4. **분류가 다를 때**: `planned_kind` 는 공지 기준 분류로 남긴다. 실제 분류는 연결된 `event.kind` 다. 화면에서 결과를 말할 때는 `event.kind` 를 쓴다(값을 하나로 덮지 않는다)
5. 변경 이력(연기 표시 등)은 후속 단계. 그때 0042 처럼 같은 트랜잭션에 전후 값을 남긴다

### 공개 경계 — `core_public.schedule_*` 뷰

- `schedule_entry`: `visibility='public'` 이고 출처가 1개 이상인 것만. `admin_note` 컬럼은 없다
- `schedule_slot`·`schedule_source`·`schedule_participant`: **부모 일정이 공개일 때만** 나온다(부모 뷰와 조인해 거른다)
- `schedule_participant`: 숨긴 스트리머 행은 빠진다
- `verify:db` 가 위 네 가지를 실제 Postgres 에서 확인한다

### 결과 연결 — 열리는 상세가 있을 때만

- 공개 일정 뷰가 `result_page` 를 함께 낸다: `'lol_tournament' | 'fc_event' | null`
- 판정은 **대회 상세 조회와 같은 조건**을 쓴다. 조건을 두 벌로 쓰지 않도록 core 에 조건 하나를 두고 양쪽이 쓴다
  - 롤: `event.kind='tournament'` + 공개 경기나 참가자가 있음(지금 `listPublicTournamentEvents` 의 조건)
  - FC: `event.game_code='fconline'` + `slug` 있음(지금 `getFcoEvent` 의 조건)
- 모듈은 `result_page` 가 있고 그 역할의 모듈이 있을 때만 링크를 그린다(`roleHref("tournaments")`·`roleHref("fc-tournaments")`)
- CK 결과 상세 화면은 이번 범위가 아니다. CK 는 결과 링크 없이 "개최 확인" 까지만

### 조회 계약 — `listPublicSchedule({ from, to, game?, scale?, streamer? })`

- **필터는 전부 URL 에 두고 서버에서 거른다**(`?from=&game=&scale=&s=`). 공유한 주소가 같은 화면을 연다
- **기간은 겹치면 포함**: 일정의 칸 날짜 범위가 `[from, to]` 와 하나라도 겹치면 일정 전체(모든 칸)를 돌려준다. 조회 시작 전에 시작한 대회도 나온다
- `streamer` 필터: 그 사람이 어떤 역할로든 참가한 일정
- 기간은 최대 31일로 자른다(조회 범위 상한)

### 방송 채널 선택

1. 칸의 `channel_id`(명시값)가 있으면 그것
2. 없으면: 주최(`role='host'`)가 **정확히 한 명**이고, 그 사람의 활성 SOOP 채널이 **정확히 하나**면 그 채널
3. 그 밖에는 채널을 표시하지 않는다(추측하지 않는다)

---

## 3. 위치

| 부분 | 위치 |
|---|---|
| 표·쓰기 접근자·공개 뷰 | core (`db/migrations/00xx`, `core/lib/db/schedule.ts`) |
| 상태 계산·채널 선택 | `core/lib/metrics/schedule.ts` |
| 관리자 입력 | `apps/web/app/admin/schedule` |
| 공개 편성표 | 플랫폼 모듈 `packages/modules/schedule` (`"site": "platform"`, `/schedule`). 자기 표가 없다 |

## 4. 관리자 입력 (`/admin/schedule`)

- 목록: 다가오는 일정 / 지난 일정. **지난 일정 중 `scheduled`(개최 미확인)를 맨 위에** — 이걸 `held`·`cancelled` 로 정리하는 게 일상 작업이다
- 폼(한 화면, 저장 한 번): 기본(게임·제목·규모·분류·후원·공개 설명·관리자 메모·공개 여부) / 칸(날짜·시작·끝·단계·채널, "매일 같은 시각으로 N일 추가") / 참가자(스트리머 검색·역할·팀) / 출처(URL·제목·작성 시각) / 상태와 결과 연결(같은 게임의 `event` 만 고를 수 있다)
- 저장 실패 사유(검증·동시 수정)는 폼에 그대로 보여주고 입력값을 잃지 않는다

## 5. 단계

| 단계 | 내용 | 상태 |
|---|---|---|
| **1. 수기 편성표** | 스키마·공개 뷰·저장 접근자·상태 계산·관리자 입력·`/schedule` 간트+목록 | **검증 완료** |
| **2. 상세와 이력** | `/schedule/[id]`(공지 시간순)·변경 이력·프로필 "다가오는 일정" — §2단계 설계 | **검증 완료** |
| 3. 개별 알림 | 유저 로그인이 생긴 뒤, 유저가 고른 스트리머·게임의 새 일정·변경을 앱 푸시·웹 푸시로. **별도 계획서** | 후속(로그인 이후) |
| 4. 자동 수집 | 게시판 표본 조사 → 새 글 수집 → 후보 → 관리자 확정 | 후속 |
| 5. CK 조사 연결 | 끝난 소형 일정의 참가자 VOD 를 CK 조사 큐 앞에 | 후속 |

## 6. 검증 (1단계 완료 기준)

| 범위 | 확인할 것 |
|---|---|
| DB·저장 (`verify:db`) | 없는 날짜 거부, 칸 날짜 ↔ 시작 시각 불일치 거부, 끝 ≤ 시작 거부, **도중 실패 시 아무것도 안 바뀜**, 출처 없는 공개 저장 거부, 다른 게임 `event` 연결 거부, 연결 중 게임 변경 거부, 오래된 `updated_at` 저장 거부, 공개 뷰가 숨김·출처 없음·숨긴 스트리머·숨긴 부모의 하위 행을 거름 |
| 계산 (`npm test`) | 상태 표의 모든 칸, 시각 미정·종료 미정, 기간 겹침(앞에서 시작한 대회), 채널 선택 3규칙, 간트 배치(기간 밖 잘림·여러 날·같은 날 순서) |
| 모듈 (`verify:modules`) | 계약·`core_public` 만 읽음, 주소 글자 없음 |
| 화면 | 필터 조합, 취소·시각 미정·종료 미정 표시, 결과 링크가 있는 것만 200 으로 열림, 휴대폰 너비, 키보드 이동 |
| 운영 준비 | `listPublicSchedule` 의 기간 조회가 인덱스(`schedule_slot (on_date)`)를 타는지, 관리자 저장 후 공개 화면에 바로 반영되는지(force-dynamic) |

## 1단계 구현 (2026-10-02)

| 부분 | 파일 |
|---|---|
| 스키마·공개 뷰 | `db/migrations/0056_schedule.sql` |
| 시간 규칙·입력 검증·채널 선택 | `packages/core/lib/metrics/schedule.ts` (+ test 13) |
| 저장·관리자 읽기 | `packages/core/lib/db/schedule.ts` (`saveScheduleEntry` 하나가 쓴다) |
| 공개 읽기 | `packages/core/lib/db/schedule-public.ts` → 계약 `listPublicSchedule` |
| 관리자 | `apps/web/app/admin/schedule/` · `components/admin/ScheduleForm.tsx` |
| 공개 화면 | `packages/modules/schedule` (`site: platform`, `/schedule`, 배치 계산 `ui/layout.ts` + test 5) |

정한 세부:
- 관리자 시각 입력은 날짜 + "HH:MM". **끝이 시작보다 이르거나 같으면 다음 날**(밤샘 방송)
- 결과 링크 판정은 각 게임의 대회 목록 함수(`listPublicTournamentEvents`·`listFcoEvents`)가 실제로 돌려주는 event 일 때만 — 상세 화면 조건을 따로 적지 않는다
- 편성표 조회 질의는 `Promise.all` 대신 순서대로 보낸다(화면 팬아웃을 늘리지 않는다, PLAN §M4-1). 검증 중 `Promise.all` 버전에서 PGlite 연결이 한 번 끊겼다 — 원인은 확인하지 않았다
- 상세 화면이 없으므로 간트의 막대·카드는 같은 화면 아래 목록의 펼침(`<details>`)으로 이어진다

검증:
- `verify:db` 편성표 27개 — 없는 날짜 거부, CHECK 2개, 출처 없는 공개 거부, **도중 실패 시 무변경**, 오래된 version 거부, held 아닌 결과 연결 거부, 다른 게임 event 거부, 연결 중 게임 변경 거부, 공개 뷰(관리자 메모 없음·숨긴 스트리머·출처 없음·숨긴 부모의 하위 행), 기간 겹침, 채널 선택, 결과 링크(FC 양성·롤 CK 음성·롤 대회 양성), 필터, 31일 상한
- 화면(메모리 DB + 시험 데이터, 실제 DB 에 쓰지 않음) 46개 — 상태 문구 5종·LIVE 없음·수기/예고 뱃지·결과 링크가 실제로 200·CK 결과 링크 없음·시각/종료 미정 표시·채널·프로필 주소·간트 막대와 잘림·필터 4종·없는 날짜 무시·머리말 메뉴(`?game=`)·키보드로 펼침·모바일(간트 숨김·가로 스크롤 없음)·관리자 목록 순서·폼 저장·밤샘 방송·**두 창 동시 수정 거부(입력값 유지)**·출처 없는 공개 저장 거부
- 운영 DB: 0056 적용 후 `/schedule`·`/admin/schedule`·`/admin/schedule/new`·`/` 200

검증하지 못한 것: 실제 일정 데이터로 본 화면(운영 DB 는 아직 비어 있다), 관리자 화면의 휴대폰 너비

## 2단계 설계 (2026-10-02)

> ⚠ **폐기된 결정**: ~~3단계 = 캘린더 구독(ICS)·디스코드 웹훅~~ → 2026-10-02 결정: 일반 유저 알림은 **로그인 + 개별 알림 설정 + 앱/웹 푸시**로 따로 계획한다.
> 캘린더 구독은 "새 일정·변경" 을 알리지 못하고 반영이 느리다. 지금은 만들지 않는다.

1. **상세 화면 `/schedule/[id]`** (id = 일정 uuid. 이름 주소(slug)는 두지 않는다 — 제목이 바뀌어도 주소가 안 깨진다)
   - 칸 전체·참가자·후원·설명, **근거 공지를 작성 시각순으로**, 변경 이력, 결과 링크(§2 조건 그대로)
   - 간트의 막대·카드는 상세로 간다. 아래 목록의 펼침에도 "상세 보기" 링크
   - 숨긴 일정·없는 id 는 404
2. **변경 이력 `schedule_change`** (마이그레이션 0057)
   - `saveScheduleEntry` 가 **같은 트랜잭션에서** 이전 값과 비교해 남긴다. 값이 그대로면 안 남긴다
   - 남기는 것: 공개 화면이 보여 주는 의미 있는 변화만 — `title` · `status` · `slots`(날짜·시각·단계). 관리자 메모·공개 여부는 공개 이력이 아니다
   - **오타 수정은 이력에 남기지 않을 수 있다**: 관리자 폼의 "오타 수정 — 변경 이력에 남기지 않음" 체크. 처음 입력을 고친 것까지 "일정 변경" 으로 보이면 거짓이다
   - 공개 뷰 `core_public.schedule_change` 는 부모 공개 조건을 상속한다
   - 화면: 상세에 시간순 이력("10/2 · 일정 변경: 10/5 시각 미정 → 10/6 19:00", "무산 처리"), 편성표 카드에 **"일정 변경"** 뱃지
3. **프로필 "다가오는 일정"** (롤·FC 프로필 모두)
   - 그 사람이 어떤 역할로든 참가한, 오늘부터 30일 안의 공개 일정 최대 5개(무산·지난 일정 제외). 게임은 가리지 않는다(사람 기준)
   - 편성표 모듈이 없으면 칸을 그리지 않는다(역할 `schedule` 로 묻는다 — core 는 모듈 이름을 모른다)

### 2단계 검증 (2026-10-02)

- `verify:db` 2단계 13개 — 첫 저장·값이 그대로인 저장은 이력 없음, 날짜 이동은 slots 한 줄("A → B"), **오타 수정 저장은 이력 없음**,
  **실패한 저장은 이력도 없음**(같은 트랜잭션), 공개 이력 최근순, 상세 읽기, **숨긴 일정은 상세·이력 모두 비공개**, 없는/형식 아닌 id,
  다가오는 일정(무산·지난 일정 제외 · 진행 중 대회는 다음 칸 기준 · 가까운 순 · 숨긴 참가자 없음)
- 화면(메모리 DB) 26개 — 상세 200·제목, **근거 공지 작성 시각순**, 변경 이력 문장·"일정 변경" 뱃지, 숨긴/없는 id 404,
  간트 막대·카드 → 상세, 목록 펼침의 "상세 보기", 롤·FC 프로필 칸(무산 제외·다음 칸 기준·숨긴 일정 없음·링크),
  관리자 이력 표시·**오타 수정 체크 시 이력 안 늘어남**·체크 없으면 늘어남, 모바일 상세 가로 스크롤 없음
- 운영 DB: 0057 적용 후 `/schedule`·롤/FC 프로필 200, 없는 일정 404
- 검증하지 못한 것: 프로필에 **다가오는 일정이 없을 때 빈 칸**으로 남는 화면(함수는 `verify:db` 가 확인 — 화면 검사는 대상을 잘못 골라 패널이 있는 경우만 봤다)

## 대기 중인 변경 — 대형/소형을 없애고 상태로만 (2026-10-02 결정, 미적용)

> ⚠ **폐기 예정**: ~~`scale`(대형/소형)~~ — 규모가 "확정이냐 예고냐" 와 "여러 날이냐 하루냐" 를 한 칸에 섞어 관리자에게 애매한 판단을 떠넘겼고,
> 지난 일정 판정은 이미 규모와 무관하다. 남은 역할(막대냐 카드냐)은 칸 날짜로 계산된다.

- **상태만으로 말한다**: 예정 · **연기(postponed — 새 일정 미정)** · 무산 · 개최 확인. 새 날짜가 정해지면 칸을 옮기고 '예정' 으로 되돌린다 → 변경 이력 "A → B"
- 지우는 것: `schedule_entry.scale`(+ 공개 뷰), 관리자 폼의 규모 선택, 공개 화면의 규모 필터·"예고" 뱃지·`SCHEDULE_SCALE_LABEL`
- 마이그레이션 초안은 작성했지만 **저장소 밖에 보관 중**이다(편성표 화면 리디자인이 끝나기 전에 `db:migrate` 가 적용하면 화면이 깨진다)
- **순서**: 편성표 화면 리디자인(다른 세션, 진행 중)이 커밋된 뒤 그 위에서 진행한다 — 같은 파일(`packages/modules/schedule/ui/*`)을 동시에 고치지 않는다

## 미정

~~공개 범위~~ → 2026-10-02 결정: 1단계부터 공개 메뉴(로비·롤·FC 머리말)에 띄운다.

