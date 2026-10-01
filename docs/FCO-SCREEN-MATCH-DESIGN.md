# FC 온라인 — 화면으로만 아는 경기의 저장 설계

> 2026-10-01 · **설계만 있다. 마이그레이션·코드는 아직 없다.** 근거는 전부 읽어서 확인한 코드·마이그레이션이다(파일:줄 표기).
> 배경: 넥슨 목록 API 는 한국 날짜 기준 최근 30일만 준다(`docs/FCO-TIME-SAMPLES.md` §목록 보관 기간).
> 그래서 30일 이전 경기, 그리고 등록 계정의 API 기록에서 빠진 경기는 **VOD 화면으로만** 알 수 있다.
> 계획 위치: `docs/CK-LOCAL-FC-PLAN.md` 이후 단계(과거 FC 백필의 전제).

## 0. 한 줄

**지금은 API 에서 받은 경기만 저장할 수 있다.** 화면에서 읽은 경기에는 넥슨 경기 ID·계정 ID(ouid)가 없어서 들어갈 자리가 없다.
LoL 은 같은 문제를 이미 풀었다(`source='manual'` + `origin='vod_scan'`, 참가자 `puuid` 선택). FC 에도 **같은 방식**을 적용하되,
**기존 API 경기의 결과가 한 글자도 바뀌지 않는 것**을 만드는 쪽의 제1 조건으로 둔다.

## 1. 확인한 사실

| # | 사실 | 근거 |
|---|---|---|
| F1 | `match` 는 이미 게임 공통이다. `game_id`·`platform_id`·`queue_id` 가 비어도 되고, `source` 에 `manual` 이 있다. 수기 경기는 `origin` 이 필수다 | `0006`, `0020:34-48`, `0026:18-30` |
| F2 | FC API 경기는 `match_id = 'fco:<넥슨matchId>'`, `source='provider_api'` 로 들어간다 | `ingest.ts:34-46` |
| F3 | `fco_match_detail` 은 `provider_match_id NOT NULL UNIQUE`, `payload NOT NULL` 이다 — 화면 경기는 이 행을 못 만든다 | `0029:25-29` |
| F4 | `fco_match_participant` 의 키는 `(match_id, ouid)`, `ouid NOT NULL`, `match_info NOT NULL` 이다. `(match_id, side_no)` 도 이미 유일하다 | `0029:31-44` |
| F5 | 공개 조회는 `JOIN fco_match_detail`(내부 조인)이고, 참가자·스트리머 연결도 `streamer_fco_account` 를 **ouid 로** 이어서 한다. 화면 경기는 지금 구조에서 조회에 아예 안 나온다 | `fconline.ts:87-99`, `:143-200`, `:223-247` |
| F6 | 참가자의 `streamer_id` 는 이미 "명시적으로 연결된 공개 스트리머만"을 담는 열이다 | `0029` 주석 |
| F7 | LoL 은 참가자 키를 `(match_id, participant_id)` 로 바꾸고 `puuid` 를 비웠으며, **화면 이름(`observed_name`)만 있어도** 자리를 만든다. 이름은 공개 뷰에 내보내지 않는다 | `0017:33-34`, `0020:60-77` |
| F8 | 조사 완료 도장은 `event_lead.raw.scan` 이고 사실상 "LoL 조사 완료"다 (`vodWork`, `core/metrics/ck-vod-status`) | `ck-backfill/SKILL.md` |
| F9 | FC 맥락 판단·근거는 `fco_match_context`(판단 이력)·`fco_context_evidence`(프레임·채팅 근거) 로 이미 `match_id` 에 건다. 근거는 `vod_title_no`+`at_sec` 좌표를 가진다 | `0032` |
| F10 | `game_creation` 은 FC 에서 **경기 종료 시각**(matchDate)이다 | `FCO-TIME-SAMPLES.md`, `ingest.ts:42` |

## 2. 풀어야 하는 문제

1. **저장 자리** — 넥슨 ID·ouid 없이 경기와 두 참가자를 저장한다 (F3·F4).
2. **조회에 나오게 하기** — 공개 화면·전적(스트리머끼리 상대 전적)에 화면 경기가 포함된다 (F5).
3. **중복 방지** — 화면으로 먼저 안 경기가 나중에 API 로 들어오거나(계정 등록이 늦은 경우), 같은 경기를 두 VOD 가 찍은 경우 **두 번 세지 않는다.**
4. **조사 완료 도장 분리** — LoL 완료가 FC 완료로 읽혀 조사 대상이 건너뛰어지지 않게 한다 (F8).
5. **정직한 표기** — 화면에서 못 읽은 값(스쿼드·슈팅·점유율 등)은 0 이 아니라 비어 있다. 수기 데이터는 화면에서 구분된다(CLAUDE.md 원칙 8).

## 3. 설계

### 3.1 경기 한 줄 — `match` 를 그대로 쓴다 (새 열 없음)

```
match_id      'fcs:<VOD번호>@<결과화면 초>'      ← 같은 화면을 다시 읽어도 같은 ID(멱등)
game_code     'fconline'
source        'manual'                           ← 「화면·수기로 안 경기」. 새 enum 값 만들지 않는다
origin        'vod_scan'                         ← match_manual_has_origin 충족
mode_key      NULL 또는 화면에서 읽은 값          ← 모르면 비운다. 지어내지 않는다
game_creation 결과 화면이 뜬 시각 = VOD 시작 + 초   ← 종료 시각(F10)과 같은 의미. 정밀도는 근거 프레임이 증명한다
source_url    https://vod.sooplive.com/player/<번호>
```

LoL 과 달리 FC 는 "같은 경기를 여러 VOD 가 찍는" 일이 흔하다(상대 방송, 대회 중계). 그래서 ID 에 **방송을 넣는 것은 임시 키**일 뿐이고,
같은 경기를 다른 VOD 에서 또 읽었을 때의 합치기는 §3.4 의 규칙으로 한다.

### 3.2 참가자 — 기존 `fco_match_participant` 의 NOT NULL 을 푼다

| 열 | 지금 | 바뀜 |
|---|---|---|
| 키 | `(match_id, ouid)` | **`(match_id, side_no)`** — 이미 유일하다(F4). ouid 는 키가 아니다 |
| `ouid` | NOT NULL | **NULL 허용** — 화면에서는 모른다 |
| `match_info` | NOT NULL | 기본값 `'{}'` — 화면 경기는 스쿼드 JSON 이 없다 |
| `observed_name` | (없음) | **추가** — 화면에서 읽은 닉네임. 공개 조회에 내보내지 않는다(F7) |
| `identity_basis` | (없음) | **추가** — 이 자리의 사람을 어떻게 정했나: `api_account`(ouid 연결) · `nickname_match`(등록 계정 닉네임과 일치) · `vod_owner`(방송 주인 본인 시점) · `manual`. 근거 없이 `streamer_id` 를 넣지 않는다(CLAUDE.md 원칙 2) |
| `goals`·`score_display` | 이미 NULL 허용 | 화면 스코어를 `score_display` 에 넣는다. **몰수·특수 상황은 못 구분하므로 `goals` 는 비운다** |
| `outcome` | `win/draw/loss/unknown` | 스코어를 읽었으면 계산하되, 승부차기 등은 `unknown` — 지어내지 않는다 |

ouid 가 NULL 이어도 `streamer_id` 는 채울 수 있다(F6). 등록 계정의 닉네임과 화면 닉네임이 일치하면 ouid 도 같이 채운다(`nickname_match`) —
이러면 나중에 API 경기와 합칠 때 가장 강한 열쇠가 생긴다.

### 3.3 `fco_match_detail` 은 화면 경기에 만들지 않는다

`provider_match_id`·`payload` 는 "넥슨이 준 원본"이라는 뜻이다. 가짜로 채우면 안 된다(CLAUDE.md "없는 값을 합성하지 않는다").
화면 경기는 **이 행이 없는 경기**다. 그래서 읽는 쪽을 고쳐야 한다(§3.5).

### 3.4 API 경기와의 중복 — 규칙 3개

| 규칙 | 내용 |
|---|---|
| **R1. 만들지 않는다** | 그 경기를 API 가 줄 수 있으면(날짜가 오늘−30일 안이고, 두 참가자 중 한 명 이상의 계정이 등록·연동됨) 화면 경기를 **만들지 않는다.** 기존 방식대로 API 경기에 맥락·근거만 붙인다. 화면은 대조용이다 |
| **R2. 나중에 API 가 들어오면 합친다** | 새 API 경기가 들어올 때(또는 점검 작업에서) 같은 경기인지 본다. **세 가지가 모두 맞아야 자동 합침**: ① 참가자 2명이 같다(ouid 또는 연결된 streamer_id) ② 종료 시각 차 ≤ ±3분(화면 시각의 오차 범위) ③ 스코어가 같다 |
| **R3. 애매하면 숨기지 않고 표시한다** | 합침 조건이 하나라도 안 맞거나 후보가 둘 이상이면 자동으로 합치지 않는다. 두 경기를 다 남기고 **"중복 의심"** 으로 검수 화면에 올린다. 지어서 합치는 것보다 사람이 보는 쪽이 낫다 |

합침의 실제 동작: 화면 경기 `visibility='hidden'`(지우지 않는다 — 복구·재수집 방지, `0020` 의 같은 관용구) + 새 표 `fco_screen_link` 에 기록,
근거(`fco_context_evidence`)와 맥락 판단은 API 경기로 옮긴다.

```sql
-- 초안(적용 전). 마이그레이션 번호는 그때의 다음 번호.
CREATE TABLE fco_screen_link (
  screen_match_id text PRIMARY KEY REFERENCES match(match_id) ON DELETE CASCADE,
  api_match_id    text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  basis           jsonb NOT NULL,         -- {participants, time_gap_sec, score} 로 무엇이 맞았나
  decided_by      text NOT NULL CHECK (decided_by IN ('auto','admin')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

같은 경기를 **두 VOD 가 찍은 경우**(화면 경기끼리 중복)도 같은 규칙(R2 의 ①②③)으로 합친다. 먼저 만든 쪽이 정본이고, 다른 VOD 는 근거만 더한다.

### 3.5 읽는 쪽 — 가장 위험한 부분

공개 조회 쿼리 약 10곳이 F5 의 구조에 기대고 있다. 바꾸는 방향:

1. `JOIN fco_match_detail` → `LEFT JOIN`, `provider_id` 는 NULL 허용(`fconline.ts:92`).
2. 참가자-스트리머 연결: `streamer_fco_account` 를 ouid 로 이어서 공개 여부를 확인하는 부분은 유지하되,
   **ouid 가 없는 참가자는 `p.streamer_id` 가 공개 스트리머인지만** 본다(F6).
3. 화면 경기는 `match.source='manual'` 이므로 **수기 뱃지**를 단다(CLAUDE.md 원칙 8). LoL 과 같은 컴포넌트·같은 규칙.
4. `observed_name` 은 어떤 공개 뷰에도 내보내지 않는다. 등록 안 된 상대는 지금처럼 "상대"로 표시된다(`fconline.ts` 의 `unlinked:` 처리).

**기존 기능이 안 바뀌는 것을 증명하는 방법(이 설계의 제1 조건):**
- 마이그레이션·쿼리 수정 **전에** 현재 공개 조회 전부의 결과를 파일로 저장한다(스트리머별 전적·상대 전적·행사·목록).
- 수정 **후** 같은 조회를 돌려 **바이트 단위로 같은지** 비교한다. API 경기만 있는 DB 에서는 100% 같아야 한다.
- 그다음에야 화면 경기를 넣어 보고, 넣은 경기만 더해졌는지 본다. `verify:db`·`verify:fco` 도 같이 통과시킨다.

### 3.6 조사 완료 도장 분리 (F8)

`event_lead.raw` 에 **`fco_scan` 키**를 따로 둔다(`scan` 과 같은 모양: `status`·`requested`·`sampled`·`failed`·`resolved_failed`).
`vodWork` 를 키 이름을 받게 일반화하고 기본값은 `scan` 이라 **LoL 동작은 그대로**다.
⚠ **적용 전 확인할 것**: `ck:merge` 가 `raw` 를 통째로 덮는지 `raw.scan` 만 갱신하는지 — 덮는다면 FC 도장이 지워진다. 4단계 구현 첫 작업으로 읽어서 확정한다.

### 3.7 화면에서 읽는 값의 범위

FC 결과 화면에서 **보이는 것만** 기록한다: 두 닉네임, 스코어, (보이면) 경기 모드·승부차기 여부. 스쿼드·슈팅·점유율은 비운다.
이 사이트의 핵심("스트리머끼리 누가 누구를 이겼나", CLAUDE.md)에는 닉네임·승패·시각이면 충분하다.
어떤 값이 화면에 실제로 보이는지는 구현 단계에서 FC 결과 화면 원본으로 확인해 `docs/` 에 남긴다 — **지금은 추정하지 않는다.**

## 4. 선택지 비교 — 왜 기존 표를 푸는가

| | A. 기존 표의 NOT NULL 을 푼다 (추천) | B. 화면 경기 전용 새 표 |
|---|---|---|
| 새 표 | `fco_screen_link` 1개 | 경기·참가자 2개 + 연결 1개 |
| 기존 API 쓰기 코드 | 안 바뀜(제약만 느슨해짐) | 안 바뀜 |
| 읽는 쪽 | 쿼리 ~10곳 수정 + **전후 동일 비교로 검증** | 쿼리마다 UNION 추가 — 수정량이 비슷하고 두 구조를 계속 맞춰야 한다 |
| 두 경기 합치기 | 같은 표라 단순 | 표를 넘나들어 복잡 |
| LoL 선례 | **있음** (`0017`·`0020`) | 없음 |
| 위험 | 느슨해진 제약을 API 쓰기가 실수로 악용(예: ouid 없이 저장) | 통계가 두 곳에서 따로 계산되어 어긋남 |

A 의 위험은 **API 저장 코드가 ouid 없는 참가자를 거부하는 검사**를 그대로 두는 것으로 막는다(`saveFcoMatch` 는 이미 `!p.ouid` 면 `unsupported`, `ingest.ts:30`).
즉 제약은 DB 에서 풀고, "API 경로에서는 ouid 필수"는 코드가 계속 지킨다.

## 5. 구현 순서와 검증

| 단계 | 일 | 통과 조건 |
|---|---|---|
| 1 | 현재 공개 조회 결과 **스냅샷 저장** (§3.5) | 파일이 생성되고 재실행 시 같다 |
| 2 | 마이그레이션: 참가자 제약·열, `fco_screen_link`. 조회 쿼리 수정 | 스냅샷과 **바이트 동일**, `verify:db`·`verify:fco`·`npm test` 통과 |
| 3 | 화면 경기 저장 함수(`saveFcoScreenMatch`) + 합침 함수(R1~R3) + 단위 테스트 | 시나리오: 같은 화면 재저장(멱등) · 나중에 API 도착(합침) · 후보 둘(의심 표시) · 못 읽은 값은 NULL |
| 4 | `fco_scan` 도장·`vodWork` 일반화 (§3.6 확인 포함) | LoL 도장 동작 불변 테스트 |
| 5 | `fco:context` 에 화면 경기 입력 창구(`apply` 확장 또는 별도 명령) — 이 단계에서 fco-research 스킬과 맞춘다 | dry-run 지원, 검수 보호(`reviewed_at`) 준수 |
| 6 | `/admin/fco` 검수 화면에 "화면 경기"·"중복 의심" 표시 | 검수자가 근거 프레임으로 승인/기각 |

## 6. 위험

| 위험 | 대응 |
|---|---|
| 읽는 쪽 쿼리 수정이 기존 화면을 바꾼다 | §3.5 의 전후 동일 비교. 통과 못 하면 마이그레이션 되돌림(제약만 푼 것이라 가역) |
| 닉네임 오독으로 엉뚱한 스트리머에게 전적이 붙는다 | `identity_basis` 로 근거를 남기고, **`nickname_match` 가 아닌 추정은 `streamer_id` 를 채우지 않는다.** 모르면 `observed_name` 만 |
| 화면 시각의 오차로 합침 실패·오합침 | ±3분은 초기값이다. R3 가 애매한 경우를 사람에게 넘기므로 오합침보다 미합침으로 기운다 |
| 화면 경기가 늘어 공개 통계가 "수기 데이터"로 오염된다 | 뱃지 필수(원칙 8). 통계 화면이 화면 경기를 포함할지는 **나중에 사용자가 정한다** — 처음에는 별도 필터로 구분 가능하게만 둔다 |
| FC 결과 화면 판별 재현율이 낮다(처음 보는 방송 26%) | 이 설계와 무관한 별도 과제 — 화면 경기를 찾는 효율만 떨어뜨리고 저장의 정확성에는 영향 없다 |

## 7. 사용자가 정한 것 (2026-10-01 — 추천안으로 확정)

1. **공개 통계에 화면 경기를 섞을지** — 추천: 저장·표시는 하되 통계 반영은 보류(뱃지로 구분), 쌓인 뒤 검수해 정한다.
2. **R1 의 "API 가 줄 수 있는" 경계** — 추천: 오늘−30일 안이면 화면 경기를 만들지 않는다. 단 등록 계정이 없는 대회 경기(Codex 지적: VOD 엔 결승이 있는데 API 엔 없던 사례)는 날짜와 상관없이 만든다. 이 경우 R2 가 나중을 책임진다.
3. **합침 자동화 수준** — 추천: R2 의 세 조건이 모두 맞을 때만 자동, 나머지는 검수.

## 8. 하지 않는 것 (이번 범위 밖)

- 행사(주최자 방송·유튜브·대진표) 단위 복원 — 스트리머 VOD 백필이 먼저다.
- 화면에서 스쿼드·슈팅 등 세부 통계 판독.
- 화면 경기 판별기(FC 결과 화면) 재학습 — 별도 과제.

## 9. 구현 직전 발견 — §3.2·§3.5 의 영향 범위가 틀렸다 (2026-10-01)

§3.5 는 "조회 쿼리 약 10곳"이라 했다. 구현 전에 `ouid` 사용처를 전부 세어 보니 **그보다 훨씬 많고, 성격도 다르다.**

1. **공개 조회의 "공개 여부 관문"이 `ouid` 로 이어져 있다.** `listFcoGamesForPerson`·`listFcoStreamerGamesForPerson`·`listFcoVersus`·`listFcoModesForPerson`·`listFcoTopPairs`·리더보드 등 약 10개 쿼리가 전부
   `JOIN streamer_fco_account link ON link.ouid = …` 로 "숨긴 계정이면 빠진다"를 구현한다(`fconline.ts:87-99`, `:143-200`, `:223-247`).
   ouid 없는 참가자는 **이 관문을 통과할 방법이 없어서 모든 전적에서 빠진다.** 각 쿼리에 "ouid 없는 참가자용 다른 관문"을 따로 달아야 한다.
2. **`ouid` 를 참가자 구분 키로 쓰는 코드가 공개 조회 밖에도 있다.** `series.ts:61-65`(세트 승수를 ouid 로 합산 — NULL 이면 두 사람이 한 키로 합쳐진다),
   `context.ts`(약 10곳: 형제 경기 비교, 참가자 목록), `scripts/fco-candidates.ts`, `fco-find-event-matches.ts`, 웹 컴포넌트(`key={side.ouid}`),
   `admin/FcoWorkspace.tsx`, `fco-match-view.ts`. 합치면 약 25곳이다.

→ §4 의 **A안(기존 표의 NOT NULL 을 푼다)** 은 "제약만 푸는 작은 변경"이 아니다. 25곳을 NULL 안전하게 고쳐야 하고, 하나라도 놓치면 조용히 틀린다.

### 대안 C — 화면 닉네임을 "임시 계정"으로 만든다 (기존 쿼리·제약을 하나도 안 바꾼다)

화면에서 읽은 참가자마다 `fco_account` 에 **`screen:<정규화한 닉네임>`** 형태의 행을 만들고(실제 넥슨 ouid 와 이름 공간이 겹칠 수 없다),
등록 스트리머면 `streamer_fco_account` 로 연결한다(근거 `source_url` = VOD, 기존 연결 규칙 그대로).
화면 경기는 `fco_match_detail` 에도 행을 두되 `provider_match_id = 'screen:<match_id>'`, `payload = {}` 로 **눈에 띄게 비어 있게** 한다.

| | A (NULL 허용) | C (임시 계정) |
|---|---|---|
| 기존 쿼리·제약 변경 | ~25곳 | **0곳** (읽는 쪽 코드는 그대로) |
| 기존 API 경기 영향 | 쿼리 수정이 만든 회귀 위험 | 없음 |
| LoL 선례 | 있음(puuid NULL) | 없음 |
| 값을 지어내나 | 아니오(NULL) | **임시 식별자를 만든다** — 이름 공간(`screen:`)과 `match.source='manual'`·`origin='vod_scan'` 으로 출처를 명시하지만 "없는 값을 합성하지 않는다"의 정신과는 긴장 |
| 새 문제 | 25곳 중 놓친 곳 | ① `payload={}` 를 읽는 화면(스쿼드·흐름·스코어보드)이 빈 값을 견디는지 확인 필요 ② `fco-candidates` 가 임시 계정을 "연결 후보"로 세지 않게 제외 ③ 같은 사람의 임시 계정(닉네임)과 진짜 ouid 가 둘 다 있을 수 있다(→ 스트리머에 둘 다 연결하면 통계는 합쳐진다) |

## 10. 결정 — A 로 가되 **단계를 나눈다** (2026-10-01, 사용자: "근본적인 방향으로")

C(임시 계정)는 **반려**했다. 식별자를 지어내는 땜질이고, "화면 경기가 일반 경기처럼 흘러다니는 것"을 막지 못한다.
A(ouid 를 정직하게 비운다)로 가되, 25곳을 한꺼번에 고치지 않고 **화면 경기가 읽히는 면을 단계로 나눈다.**

### 발견 — 이미 있는 구조가 첫 단계를 공짜로 안전하게 해 준다

- 실제 DB 의 FC 경기 2,790건은 전부 `provider_api`, 참가자 5,580명은 전부 ouid 가 있다(읽기 전용 조회).
- 화면 경기는 `fco_match_detail` 행이 없고 ouid 가 NULL 이다. **기존 공개 조회는 전부 `JOIN fco_match_detail` 또는 `link.ouid = p.ouid` 로 시작하므로 화면 경기가 구조상 결과에 안 나온다.**
  → 기존 공개 조회 쿼리를 **한 줄도 안 고쳐도** 화면 경기는 안 새고, API 경기 결과는 그대로다. 사용자 결정 1(통계 반영 보류)과 정확히 일치한다.
- 약 25곳 중 실제로 화면 경기를 볼 수 있는 곳은 **`fco_match_detail` 을 거치지 않고 참가자를 읽는 몇 곳**뿐이다
  (`context.ts` 시리즈 형제 대진 비교, `series.ts` 키). 나머지는 이미 detail 조인으로 걸러진다.

### 단계

| 단계 | 내용 | 기존 기능 영향 |
|---|---|---|
| **1. 저장** | 마이그레이션(ouid NULL 허용·키 `(match_id, side_no)`·`identity_basis`·검사)·`fco_screen_link`·`fco_participant_key()` 함수. 저장·합침 함수. **공개 쿼리는 안 건드린다** | 스냅샷 동일(§3.5) + 화면 경기를 넣어도 공개 조회가 **그대로**라는 검증 |
| **2. 내부 안전** | 시리즈 형제 대진 비교(`context.ts`)가 `fco_participant_key()` 를 쓰게 한다(ouid NULL 이면 streamer, 그것도 없으면 닉네임) | 같은 스냅샷 + 시리즈 시나리오 테스트 |
| **3. 검수 표시** | `/admin/fco` 에 화면 경기·중복 의심. 사람이 근거 프레임으로 승인 | 관리자 화면 한정 |
| **4. 공개 표시** | 검수된 화면 경기를 공개 화면에 "수기" 뱃지와 함께. **공개 여부 관문을 한 곳(뷰)으로 모으는 것은 이 단계의 설계 과제**이며, 이때 통계 포함 여부를 사용자가 정한다 | 단계 시작 전에 별도 설계 |

참가자 이름은 새 열을 만들지 않고 기존 `nickname` 에 **그 화면에 보인 이름**을 넣는다(API 경기도 "경기 당시 닉네임"이다 — 같은 뜻).
따라서 앞서 문서에 적은 `observed_name` 열은 **만들지 않는다.** `identity_basis` 만 추가한다.

## 11. 단계 1 구현 결과 (2026-10-01)

§3·§4·§9 중 아래와 다른 부분은 **이 절이 맞다**(구현하며 바뀐 것).

| 문서 | 구현 |
|---|---|
| §3.2 `observed_name`·`identity_basis` 4값 | `observed_name` 은 만들지 않았다(`nickname` 이 같은 뜻). `identity_basis` 는 `nickname_match`·`vod_owner`·`manual` 3값, API 참가자는 NULL |
| §3.2 닉네임 일치 시 ouid 도 채움 | **ouid 는 NULL 로 둔다** — 닉네임으로 계정을 단정하지 않는다. 등록 계정 닉네임과 **정확히 하나만** 일치하면 스트리머만 붙이고(`nickname_match`), 동명이면 안 붙인다 |
| §3.3 detail 행 없음 | 맞다. 단 **참가자 FK 가 detail 을 참조하고 있어서** 0050 이 참조를 `match` 로 옮겼다(검증 스크립트가 발견). detail 행만 지우는 코드는 없음을 확인 |
| §3.4 R1~R3 | `saveFcoScreenMatch`(R1)·`reconcileFcoScreenMatches`(R2)·`findFcoScreenSuspects`(R3). R2 는 API 저장 경로에서 부르지 않고 자동 수집 뒤 따로 부른다 |
| 화면 경기의 공개 여부 | 처음엔 `visibility='hidden'`(검수 전). 검수 승인은 단계 3 |

**검증(전부 통과):** `verify:fco-screen`(신규 — 저장·멱등·못 읽은 값 NULL·닉네임 일치/동명·근거 없는 지정 거부(코드+DB 제약)·검수 보호·R1 3종·중복 VOD·R2 합침·R3 의심·후보 2개 거부·**화면 경기가 있어도 기존 공개 조회 결과가 한 글자도 안 바뀜**),
`verify:fco`·`verify:fco-context`·`verify:db`·`verify:modules`·`typecheck`·`npm test`(232), 가짜 DB 스냅샷 전후 동일(`scripts/fco-public-snapshot.ts`).

**아직 안 한 것:** 실제 DB 에 0050 적용(적용 전 `--status` 와 실제 DB 스냅샷 전후 비교), 단계 2(`context.ts` 시리즈 형제 대진 비교를 `fco_participant_key()` 로),
`fco_scan` 도장(§3.6), 단계 3·4.
