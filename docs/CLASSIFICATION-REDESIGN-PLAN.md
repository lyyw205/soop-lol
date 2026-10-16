# 경기 분류·수집 뼈대 재설계

> 2026-10-16 작성. 사용자 결정(§1)과 전수조사 7건(공개 화면 롤·FC·공통 규칙·관리자/수집, 뼈대 조사 롤·수집·FC)을 바탕으로 한다.
> 숫자는 모두 같은 날 운영 DB 읽기 전용 조회 값이다.
> **설계 확정(2026-10-16).** §10 결정 5(파생 표 폐지)만 1단계 성능 측정으로 확정한다. 확정되면 [SERIES-EVENT-MODEL.md](SERIES-EVENT-MODEL.md) 를 대체한다.
>
> **2026-10-16 개정(Codex 검토 반영, 코드 대조로 확인).** ① 맵 NULL 이 FC 를 공개 필터에서 통째로 떨어뜨림 → 게임별 명시 조건,
> `scope NOT NULL`(§3.1·§3.3·§5.1). ② 사람의 "이 행사가 아니다" 판단은 소속만으로 보존 불가 → 제외 표를 **현재 제약**으로 유지(§3.7).
> ③ 솔랭내기는 같은 판 상대편 모델에 안 맞는다 → 값만 예약하고 결과 구조는 그 기능 설계로 미룸(§3.5). ④ 계정 없이 사람만 확인된
> 수기 참가자의 공개 규칙(§5.1). ⑤ 미상이 섞인 시리즈·상대전적 결과 조합표(§5.2). ⑥ 자동 미분류 그릇을 순서 무관·재실행 무관한
> 결정적 키로, 사람이 분류한 행사에 자동 편입 금지(§3.4). ⑦ 전환에 쓰기 차단·되돌리기, 디스크 회수 분리(§8). ⑧ 이관 대조를 건수가
> 아니라 ID·값 집합으로(§8). 그리고 "전체 = 칩 합"의 범위, 개인 기록 공개 경로, 성능 기준을 명시했다.

## 0. 한 문단 요약

사이트가 보여 줄 것은 **스트리머 간 내전**이다. 그래서 경기의 분류는 "어느 맵에서(협곡·칼바람), 어떤 진행 방식으로
(CK·랜드·대회·스크림·솔랭내기·concept / FC 는 대회·CK·concept·친선)" 두 가지뿐이다. 진행 방식은 **행사에만** 붙고, 행사는
**시리즈에만**, 모든 내전 판은 **반드시 시리즈에** 속한다. 모르는 것은 행사의 진행 방식 `unclassified` 라는 **값 하나**로만 표현한다.
수집 경로(API·영상·수기·토너먼트 코드)는 분류를 정하지 않는다. 공개 큐 개인 전적은 전원 수집을 없애고 **지명한 것만** 모은다.
모든 공개 집계는 **고르기·세기·보여 주기 함수 각 하나**만 거치고, 세트와 시리즈를 항상 함께 낸다. 옛 분류 체계
(`lol_match_category`, `event.kind`, `match.event_id`, `source`+`origin`, 저장된 `category` 칸)는 옮겨 담은 뒤 **지운다** —
변환층을 두지 않는다.

---

## 1. 확정된 결정 (2026-10-16 사용자)

| # | 결정 |
|---|---|
| 1 | 내전과 CK 는 같은 말이다. **보상 여부는 분류 기준이 아니다** |
| 2 | 롤 분류 = ① 협곡/칼바람 ② (협곡이면) 진행 방식 CK·랜드·대회·스크림·솔랭내기, 그 외는 concept. 다섯 모두 스트리머 간 내전이다 |
| 3 | 정해진 형식 밖의 특별한 컨셉 내전의 이름은 **concept** (롤·FC 공통). "이벤트"·"커스텀"은 이미 다른 뜻이라 쓰지 않는다 |
| 4 | 토너먼트 코드는 별도 분류가 아니다 — 메타데이터를 얻기 쉬운 입력 수단이다 |
| 5 | FC 분류 = 대회·CK·concept·친선. 경기 모드(공식/친선 등)는 분류와 **별개 속성** |
| 6 | FC 경기 맥락 판단 = 위 진행 방식 중 무엇인지 판단한 결과다 |
| 7 | 확인된 것만 라벨을 붙인다. 미분류는 라벨 없이 **공개한다**(VOD 자동 조사는 대부분 미분류로 나온다 — 공개 뒤 고친다) |
| 8 | 칼바람은 진행 방식 값을 저장하되 화면에서 나누지 않는다 |
| 9 | 보너스 판은 집계에서 제외한다 |
| 10 | 집계는 **세트와 시리즈 둘 다** 항상 같이 표시. 랜드도 매 판이 세트, 그날 전체가 시리즈 |
| 11 | 분류 필터는 모든 집계의 기본 축이다 |
| 12 | 공개 큐(솔랭·자유·일반·칼바람·클래시) 개인 전적은 거의 필요 없다. 랭크 점수만 전원 매일. 경기 기록은 **지명했을 때만** 그 사람들 것만 |
| 13 | 기존 공개 큐 27,042판은 지운다(솔랭 도전 범위 110판만 남김) |
| 14 | 지명된 판의 나머지 참가자는 **내전 수준의 기본 칸만**, 상세 지표는 **지명한 사람만** |
| 15 | 남이 발급한 토너먼트 코드 829판은 지우지 않고 미분류로 남긴다(사용자가 내전/시청자 참여를 확인) |
| 16 | 엑셀 등록 경기는 출처 구분 없이 그냥 CK. 분류 확정 뒤 사용자가 다시 지정한다 |
| 17 | 엑셀 대조에서 값이 같으면 검수 완료 처리하는 것은 사용자 지시 규칙이다(문제 아님) |
| 18 | **땜질 금지** — 뼈대부터 다시 세운다 |

---

## 2. 왜 뼈대부터인가 — 지금 구조의 결함

화면마다 숫자가 다른 증상(사이드바 18:27 vs 상세 11–16, 모스트 챔피언 455 vs 459, FC 요약 623경기 vs 탭 254경기,
양쪽 몰수패가 순서 따라 18–23/21–20 등)은 아래 구조 결함에서 나온다. 데이터 자체(원본↔파생)는 차이 0 으로 깨끗하다.

| # | 결함 | 결과 |
|---|---|---|
| 1 | **한 칸(분류)이 다섯 질문에 답한다** — 게임 방식(매칭/사용자 설정), 맵, 자리(대회/내전), 세는 법(랜드), 수집 경로·모름 | 같은 내전이 "CK"·"칼바람 내전"·"코드 내전"·"기타"로 갈린다. 공개 "기타" 482판 = 엑셀 CK 333 + VOD 내전 80 + 모르는 공개 큐 69 |
| 2 | **행사가 경기에 붙는 길이 둘** — `match_series.event_id`, `match.event_id` | 읽는 쪽 약 40곳이 `COALESCE(ms.event_id, m.event_id)` 를 복사. 두 길을 같이 쓰는 행사 17개 |
| 3 | **판이 시리즈 밖에 있을 수 있다** — VOD 직접 경로 303판, 엑셀 102판, FC 4,754판(99.7%) | 세는 코드마다 "시리즈 없으면…" 분기. 랜드·CK 승패 규칙이 TS 1곳 + SQL 3곳 |
| 4 | **"모른다"가 들어갈 자리가 없다** — 행사가 없거나 kind 가 `other` 면 기타로 샌다. 조사 규칙은 "보상 미확인이면 `other`" | 모름과 "기타 형식"이 한 값. FC 는 "모름"을 `fco_match_context` 에, 결론은 행사 연결에 — 답이 여섯 군데 |
| 5 | **수집 대상이 "연결된 계정 전원"** — 계정 연결 시 백필 대기열에 자동 등록(`streamers.ts:358`) | 10/02 하루 백필 1,151회·27,791판. 참가자 273,605행 중 89%가 일반인, DB 의 40%. 스트리머끼리 상대편으로 만난 판은 595판(2.2%). 지금도 321계정 대기 중 |
| 6 | **참가자 한 행에 상세 지표(JSON 포함)가 다 붙어 있다** | 일반인 27만 행에도 상세가 찬다. 칸 11개는 쓰기만 하고 읽는 곳 0 |
| 7 | **파생 표가 원본과 다른 길로 만들어진다** — 조우·챔피언 통계는 계정 공개 여부를 안 본다 | 부계정을 숨기면 매치 히스토리에선 빠지고 상대전적·모스트엔 남는다(잠복, 지금 숨긴 계정 0) |
| 8 | **고르기·세기·보여 주기가 화면마다 따로** | 같은 페이지에서도 칸마다 범위·단위·필터 적용이 다르다(조사 B 목록 수십 건) |

---

## 3. 새 뼈대

### 3.1 계층과 불변식

```
행사 event        game_code · name · slug · format(진행 방식, NOT NULL)
 └ 시리즈 series   event_id NOT NULL · best_of(근거 필수) · set_order_known
    └ 세트 match   series_id · series_game_no · set_role(main/bonus) · map · collected_via · scope · 원본 사실
       └ 참가자    기본 칸만
          └ 상세    지명한 사람만 (별도 표)
```

**DB 가 강제하는 불변식** (코드의 조심이 아니라 저장 거부):

| 불변식 | 강제 |
|---|---|
| 진행 방식은 행사에만 있다 | `match.event_id` 칼럼 삭제. `event.format NOT NULL` |
| 행사는 시리즈에만 붙는다 | `match_series.event_id NOT NULL` |
| 판은 내전 세트이거나 개인 기록이다 | `scope NOT NULL CHECK (scope IN ('versus','personal'))` — CHECK 는 NULL 을 막지 못하므로 NOT NULL 을 따로 건다 |
| 내전 판은 반드시 시리즈에 속한다 | `CHECK ((scope = 'versus') = (series_id IS NOT NULL))` |
| 맵은 게임별로 정해진다 | 롤: `map NOT NULL` 이고 `rift`·`aram`·`unsupported` 중 하나. FC: `map IS NULL` |
| 게임별 허용 진행 방식 | `CHECK` (game_code, format) 허용 목록 — §3.2 |
| 행사·시리즈·세트의 게임 일치 | 복합 FK (지금 시리즈↔세트만 있고 행사↔시리즈는 코드만 가정) |
| 보너스는 시리즈 안에서만 | 기존 `match_bonus_in_series` 유지(시리즈 필수가 일반 규칙이 되어 자연히 성립) |
| best_of 는 근거와 함께 | 기존 유지 |

경기가 "어느 진행 방식인가"를 찾는 길은 **세트 → 시리즈 → 행사** 하나뿐이다. `COALESCE` 가 사라진다.

### 3.2 진행 방식 (`event.format`)

| 값 | 이름 | 롤 | FC | 뜻 |
|---|---|---|---|---|
| `ck` | CK | ✓ | ✓ | 스트리머 간 내전(보상 무관) |
| `land` | 랜드 | ✓ | | 맞라인을 정하고 매 판 팀을 섞는 내전 |
| `tournament` | 대회 | ✓ | ✓ | 대회 |
| `scrim` | 스크림 | ✓ | | 대회 준비 연습 |
| `solo_bet` | 솔랭내기 | ✓ | | 솔로랭크 결과로 겨루는 내전(기능은 곧 추가) |
| `concept` | concept | ✓ | ✓ | 정해진 형식 밖의 특별한 컨셉 내전 |
| `friendly` | 친선 | | ✓ | FC 친선 |
| `unclassified` | (라벨 없음) | ✓ | ✓ | 아직 판단하지 않음·판단 불가 |

- **`concept` 은 사람이 고르는 값**이다. 모를 때 떨어지는 칸이 아니다. 모르면 `unclassified` 다 — 지금 "기타"가 쓰레기통이 된 원인은 둘을 섞은 것이다.
- 화면 칩 순서·이름·게임별 허용은 core 한 곳(`metrics/format.ts`)과 DB CHECK 가 같은 목록을 쓰고 `verify:db` 가 대조한다.
- 옛 `showmatch` 는 `concept` 으로 간다(FC "이벤트매치 = concept", 사용자 결정 3·5).

### 3.3 세트의 속성 — 분류가 아닌 것

| 칸 | 값 | 쓰임 |
|---|---|---|
| `map` | `rift` 협곡 · `aram` 칼바람 · `unsupported`(아레나·우르프 등, 집계 제외) | 롤 맵 탭. Riot `game_mode`·`map_id` 에서 한 번 정해 저장한다(지금처럼 매 질의마다 재계산하지 않는다). FC 는 맵 구분이 없어 NULL(`CHECK` 로 게임별 강제) |
| `set_role` | `main` · `bonus` | 보너스는 모든 집계에서 제외(결정 9). 펼친 목록에서만 보인다 |
| `collected_via` | `api` · `vod` · `manual` | **어떻게 알았나.** `source`+`origin` 두 칸을 합친다. 위키 시드·엑셀·검수 화면 입력은 `manual`(근거는 기존 근거 칸). FC 화면 판독은 `vod`. 분류 판정에 쓰지 않는다 |
| `tournament_code` | 문자열 또는 NULL | 토너먼트 코드 경기 여부는 이 칸이 채워졌는지로 안다(결정 4) |
| `scope` | `versus` 내전 세트 · `personal` 개인 기록 | §3.5 |
| `mode_key` (FC) | 넥슨 matchtype | 보조 필터. 라벨은 넥슨 뜻 그대로(40 = "클래식 1on1", 분류의 "친선"과 다른 말) |

### 3.4 미분류의 자리 — 값은 하나, 그릇은 자동 전용 묶음

미분류는 `event.format = 'unclassified'` **하나로만** 표현한다(시리즈의 행사를 비워 두는 두 번째 표현을 만들지 않는다).
행사 없이 들어오는 판은 **자동 미분류 묶음 행사**(`event.auto_bucket = true`)에 담긴다. 묶음의 키는 판 자체에서 정해지는
값이라 **들어온 순서·재실행·동시 수집과 무관하게 같은 판은 항상 같은 묶음**에 간다:

| 들어오는 판 | 그릇 |
|---|---|
| VOD 조사 | 지금처럼 조사가 실제 행사를 만든다. 형식을 확인 못 하면 `unclassified` (자동 묶음이 아니다) |
| FC 스트리머끼리 API 경기 | 묶음 키 = (두 사람, KST 날짜). slug `fc-auto-<날짜>-<두 사람 id 정렬>` |
| 토너먼트 코드 경기 | 묶음 키 = KST 날짜. slug `lol-code-auto-<날짜>` |
| 일괄 등록(엑셀 등) | 등록 도구가 실제 행사를 지정받는다(지정 필수) |

규칙:
- 자동 묶음은 **자동 수집 전용 그릇**이다. 사람은 묶음의 `format` 을 바꾸지 않는다 — 분류는 시리즈를 **실제 행사로 옮기는 것**이다
  (새로 만들거나 있는 행사를 고른다). 그래서 묶음은 영원히 `unclassified` 이고, 늦게 들어온 판이 사람이 분류한 행사에 자동으로 섞이는 일이 구조적으로 없다.
- 자동 경로는 **자동 묶음 행사에만** 판을 넣는다. 실제 행사(`auto_bucket = false`)에 판을 붙이는 것은 VOD 조사·사람·일괄 등록뿐이다(`CHECK`/트리거로 강제할 수 있는 범위는 1단계에서 정한다).
- 저장은 `match_id` 기준 upsert, 묶음 행사는 slug 기준 `INSERT … ON CONFLICT` — 동시에 두 번 돌아도 판·묶음이 하나씩이다.
- 묶음 안의 세트는 **한 판짜리 시리즈**(`set:<match_id>`)다. 여러 판을 한 시리즈로 묶는 것은 사람이 한다(결정 10 전제).
- 사람이 어떤 행사에서 **뺀** 판은 묶음에 남고, 자동 경로가 그 행사로 되돌리지 못한다(§3.7 제외 표).
- 옛 FC "대전"(40분 간격, `sessions.ts`)은 검수 화면이 묶음 안에서 판을 나눠 보여 주는 표시로만 남긴다 — 저장 규칙이 아니다(순서 의존이라).

### 3.5 개인 기록 (`scope = 'personal'`) — 내전이 아닌 판

지명 수집한 공개 큐 판(솔랭 도전 등)은 내전이 아니다. 시리즈·행사 없이 `scope='personal'` 로 저장하고, **내전 집계·필터에는
절대 들어가지 않는다.** 솔랭 도전 같은 전용 화면만 읽는다(공개 경로 `core_public.personal_game`, §5.4).

**솔랭내기는 이 문서에서 값(`solo_bet`)만 예약한다.** 솔랭내기는 A·B 가 **서로 다른** 솔랭 판의 결과로 겨루는 것이라, "같은 판의
상대편"으로 상대전적을 만드는 내전 모델(§5.1)에 맞지 않는다. 반대로 A 의 솔랭에 우연히 나온 다른 스트리머가 내기 상대로 잡혀서도 안 된다.
그래서 솔랭내기의 구조(누가 누구와 겨루나, 무엇으로 이기나, 쓰인 판은 어떤 개인 기록 판인가)는 **그 기능을 설계할 때 별도 결과 표로** 정한다.
이 문서가 고정하는 원칙은 둘이다: 개인 기록 판은 그 자체로 내전 세트가 되지 않는다(`scope` 를 바꾸지 않는다), 솔랭 도전 기록은 솔랭내기와 무관하게 유지된다.

### 3.6 참가자 — 기본 칸과 상세 표

근거: 칼럼별 읽는 곳과 채움률 실측(VOD 판독 9,810행 vs 공개 큐 273,605행).

| 구분 | 칼럼 |
|---|---|
| **기본** (모든 판·모든 참가자) | match_id, participant_id, puuid, streamer_id, observed_name, team_id, side_no, team_position, individual_position, champion_id, champion_name, champ_level, kills, deaths, assists, outcome — 지금 VOD 판독이 채우는 칸과 같다(`ck.ts:1068-1077`) |
| **상세** (`lol_participant_detail`, 지명한 사람 행만) | cs, gold_earned, damage_to_champions, vision_score, items, summoner1/2, perks, challenges — 지금 솔랭 도전만 읽는다 |
| **버림** (쓰기만 하고 읽는 곳 0) | lane, role, damage_taken, wards_placed, wards_killed, control_wards, turret_kills, first_blood_kill |
| match 칸 버림 | game_type, game_start, game_end, has_timeline(전 행 false, 타임라인 표 없음) |

- 챔피언 탭의 "분당 CS"는 없앤다 — 내전 판에는 원래 CS 가 없고(채움 0%), 다른 스트리머 행이 NULL 이면 분당 값이 묽어지는 결함이 이미 있다.

### 3.7 분류 판단의 이력 — 롤·FC 공통

FC `fco_match_context`(casual/unresolved) 와 `fco_event_match_decision`(경기 단위 포함/제외)은 "무슨 판인가"의 답을 행사 밖에
나눠 둔 구조다. 새 뼈대에서는:

- **현재 판단 = 행사의 `format` 과 시리즈의 행사 소속**, 그리고 아래 **제외 표**가 전부다.
- **제외는 소속으로 표현할 수 없다.** "이 판은 A 행사가 아니다"라는 사람의 판단은, 판이 지금 어디에 있는지로는 알 수 없다(묶음에
  있어도 A 에서 뺀 것인지 아직 안 본 것인지 모른다). 그래서 `event_exclusion(event_id, match_id, decided_by, note, decided_at)` 을
  **현재 제약**으로 둔다 — 이력이 아니다. 판을 행사에 붙이는 모든 경로(자동 조사·VOD 반영·시리즈 이동·일괄 등록)는 core 함수 하나
  (`assertNotExcluded`)를 거치고, 사람(`decided_by='admin'`)의 제외가 있으면 자동 경로는 거부된다. 지금 FC 의 `isHumanExcluded`
  (`context.ts:11`)가 하는 일을 롤·FC 공통으로 옮기는 것이다. 사람이 제외를 풀면 행을 지운다(이력은 `review_change`).
- **판단 이력·근거**는 기존 `review_change`(누가·언제·전후 값) + 근거 표(`fco_context_evidence` 를 게임 공통 `classification_evidence` 로)에 남긴다.
- 자동 판단이 사람 판단을 덮지 못하는 보호는 기존 셀 잠금(`review-lock`) 규칙을 행사·시리즈 칸에 적용한다.
- `fco_match_context` 의 메모(근거·남은 질문)는 이력으로 옮기고 표는 지운다. `fco_event_match_decision` 의 최신 admin exclude 는 `event_exclusion` 으로, 나머지는 이력으로.

---

## 4. 수집

| 수집 | 대상 | 저장 |
|---|---|---|
| **랭크 점수** | 연결된 활성 계정 전원, 매일 09:00(지금 그대로) | `rank_snapshot`, 닉네임 갱신 |
| **지명 수집** | `collection_target`(새 표) 에 사람이 등록한 것만 — 계정·큐·기간(시작·끝)·목적·메모 | `scope='personal'` 판. 참가자 기본 칸 10명 + 지명 계정만 상세 |
| **내전 입력** | VOD 조사, 검수 화면, 일괄 등록 도구, 우리가 발급한 토너먼트 코드 | `scope='versus'` 판 — 반드시 행사·시리즈 안 |
| **FC** | 넥슨 API(지금 그대로) | 스트리머끼리 판 → `versus`((두 사람, 날짜) 자동 미분류 묶음), 그 외 → §10 결정 3 |

- **막을 입구**: 계정 연결 시 자동 백필 등록(`streamers.ts:358-362`, `seed-streamers.ts:238`, `identify-candidates.ts:240`) 을 없앤다.
  워커의 실시간(B)·백필(C) 엔진은 `collection_target` 만 읽는다 — 목록 밖 공개 큐 판을 저장할 경로가 **코드에 없다**.
- `ingest_cursor` 의 검증된 로직(커서 내리기·끝 감지·SKIP LOCKED)은 재사용하고 키만 `collection_target` 단위로 바꾼다.
- 솔랭 도전의 `challenges.json` 계정·기간은 `collection_target` 으로 옮긴다(모듈은 core 를 import 하지 못하므로 core 표가 정본).
- **일괄 등록 도구**를 저장소에 정식으로 둔다(`scripts/ck-import.ts`). 엑셀 등록은 `out/` 임시 스크립트였다. 이 도구는 행사 지정을 요구하고, 대조 규칙(결정 17)을 그대로 쓴다.
- 조사 스킬 문장을 고친다: `ck-research`("보상이 확인되지 않은 친목 내전은 `other`" → 형식을 모르면 `unclassified`, 보상 기준 삭제),
  `fco-match-context`(결론 = 진행 방식 판단, casual/unresolved 폐지), `ck-auto.sh` 프롬프트. 정의가 바뀌는 변경이라 원문 이동이 아니다 —
  바꾼 문장 목록을 남기고 첫 실행들을 사람이 확인한다.

---

## 5. 집계와 노출 — 함수 셋, 검사 하나

### 5.1 고르기 — 공개 세트 하나

`core_public.versus_set`(뷰) 한 곳에서만 공개 내전 세트를 고른다. 조건:
- 공개 경기, `scope='versus'`, `set_role='main'`
- 맵은 **게임별로 명시**한다: `(game_code = 'lol' AND map IN ('rift','aram')) OR game_code = 'fconline'`.
  `map <> 'unsupported'` 처럼 쓰면 FC 의 `map IS NULL` 이 비교 결과 NULL 로 떨어져 FC 전부가 빠진다(PGlite 재현).
- 참가자가 **누구로 확인됐나**에 따라 공개 규칙이 하나씩:
  - 계정으로 확인(`puuid` 가 연결 계정) → 그 **계정과 스트리머 둘 다 공개**일 때만.
  - 계정 없이 사람만 확인(VOD 판독의 `puuid IS NULL AND streamer_id IS NOT NULL`, 0021) → **스트리머 공개**일 때만.
  - 같은 자리에 둘 다 있으면 계정 규칙이 이긴다 — 나중에 숨긴 계정으로 연결되면 그 자리는 공개 뷰에서 빠진다.
  - 둘 다 아니면(미등록 자리) 스트리머 기록에는 안 잡히고 경기 상세의 이름 칸에만 보인다(지금 규칙 유지).

한 행 = (사람, 세트) 이고 시리즈·행사·format·map·날짜(KST)·결과·챔피언·포지션을 단다.
상대전적은 같은 뷰의 자기 조인(`versus_pair_set`) — 같은 판의 두 사람과 관계(같은 팀/상대편).

- **파생 표를 없애는 방향**: 공개 큐를 지우면 내전 판은 약 2.7천 판이다. 조우(`streamer_encounter`)·챔피언 통계(`champion_stat`)·
  `mod_versus.pair` 를 뷰 계산으로 바꾸면 "파생 표가 원본과 다른 길로 만들어지는" 결함 7 이 구조적으로 사라진다.
  확정 조건(§10 결정 5): PGlite 는 기능 검사만 하고, 속도는 **운영과 같은 버전의 PostgreSQL 에 운영 복사본**을 올려 잰다.
  대상은 프로필(요약·매치 히스토리·상대 전적·챔피언 탭), 상대전적 상세·사이드바, 스트리머 목록, 홈 숫자 — 각 질의가 **200ms 이하**.
  넘는 것만 인덱스 → 그래도 넘으면 그 하나만 물질화 뷰(원본에서만 만들고 같은 공개 규칙)로 둔다.
- 기간은 시리즈 첫 본게임의 KST 날짜로 판단한다(지금 규칙 유지, 정의는 `time.ts` 한 곳).

### 5.2 세기 — 세트와 시리즈

core 헬퍼 하나(`metrics/tally.ts`)가 세트 행을 받아 `{ sets: {win, draw, loss, unknown}, series: {win, draw, loss, unknown} }` 를 돌려준다.

- **세트**: 본게임 한 판의 결과(승·무·패·미상).
- **시리즈**: 그 시리즈에서 **센 세트들**로 정한다. 승 W·패 L·미상 U(무 세트는 어느 쪽에도 안 센다):

  | 조건 | 시리즈 |
  |---|---|
  | W > L + U | 승 — 미상이 전부 패여도 뒤집히지 않는다 |
  | L > W + U | 패 |
  | W = L 이고 U = 0 | 무 |
  | 그 밖 | **미상** — 예: 1승 0패 2미상은 아직 승이 아니다 |

  - CK 2:1 승리 팀원 → 세트 2승 1패, 시리즈 1승. 랜드 4승 3패 → 시리즈 1승.
  - 일부 세트만 뛴 사람은 **본인이 뛴 세트로만** 센다(진 판 하나만 뛰었으면 시리즈 1패). 랜드와 같은 규칙이라 분기가 없다.
  - 저장된 세트만 센다. 안 들어온 세트를 `best_of` 로 짐작하지 않는다 — 판이 더 들어오면 위 표대로 다시 계산될 뿐이다.
  - 상대전적 A vs B 는 **둘이 상대편이었던 세트만** 골라 같은 표.
- **상대전적의 세트 결과는 두 사람의 결과 짝으로 정한다** — 그래서 A 의 기록과 B 의 기록이 언제나 거울이다:

  | A | B | A 기준 |
  |---|---|---|
  | 승 | 패 | 승 |
  | 패 | 승 | 패 |
  | 무 | 무 | 무 |
  | 패 | 패 | 무 (양쪽 몰수 — FC 112쌍, 롤 이상 조우 12줄) |
  | 그 밖(승/승·무/패·미상이 낀 짝 등) | | 미상 — 데이터 모순이므로 관리 화면의 정합성 목록에도 올린다 |

  개인 기록은 본인 결과 그대로다(양쪽 몰수면 각자 패).
- **승 + 무 + 패 + 미상 = 판 수**(세트·시리즈 각각). 미상이 있으면 항상 보인다(지금은 일부 화면이 숨겨 합이 안 맞는다).
- 맵이 섞인 시리즈(칼바람+협곡 랜드 2개)는 맵 탭마다 그 탭의 세트로 시리즈를 센다.
- 지금 TS 1곳 + SQL 3곳에 있는 다수결·랜드 규칙과 죽은 `buildOpponentHistory` 는 지운다.

### 5.3 보여 주기 — 부품 하나, 필터 하나

- 기록 부품 하나(`RecordPair`)가 세트와 시리즈를 늘 나란히 보인다. 화면이 숫자 하나만 꺼내 쓰지 못하게 부품의 입력을 `tally` 결과 통째로 받는다.
- 필터: `전체 · CK · 대회 · concept · 스크림 · 랜드 · 솔랭내기 · 분류 전` (FC: `전체 · 대회 · CK · concept · 친선 · 분류 전`) + 롤 맵 탭(협곡/칼바람).
  **한 맵 탭 안에서 "전체" = 진행 방식 칩들의 합**이다(세트·시리즈 모두). 몰래 빠지는 값이 없다. 미분류 판은 "분류 전" 칩에 보이고 분류하면 해당 칩으로 옮겨 간다.
  맵 탭끼리는 세트 수만 더해진다 — 맵이 섞인 시리즈는 양쪽 탭에 하나씩 잡히므로 시리즈 수는 탭끼리 더하지 않는다.
- 표본 표기(원칙 3)·수기 뱃지(원칙 8)·계정 신뢰도(원칙 2)는 이 부품과 행 부품에서 한 번에 처리한다 — 다음 문서(화면 노출 정리)의 범위.

### 5.4 강제 — 검사

- `verify:modules` 류 정적 검사: 공개 경로(apps/web 공개 라우트, packages/modules, contract)에서 `match`·`match_participant` 원본이나
  `core_public` 의 옛 뷰를 직접 읽으면 실패. 허용하는 공개 경로는 셋뿐이다:
  - 내전 집계: `versus_set`/`versus_pair_set` + `tally`
  - 개인 기록(솔랭 도전, FC 의 개인 기록 — §10 결정 3): `core_public.personal_game`
  - 경기 상세·행사 상세 화면의 한 경기 보기: `core_public.match_detail`(경기 하나의 참가자 전체, 같은 공개 규칙)
- `verify:db`: 새 불변식마다 "잘못된 행이 저장 거부되는가"를 실제로 넣어 본다 — `scope` NULL, 시리즈 없는 내전 판, 게임 불일치,
  허용 밖 format, 롤 판의 `map` NULL·FC 판의 `map` 값, 자동 경로가 실제 행사·제외된 행사에 판을 붙이기, 그리고 FC 판이 공개 뷰에 나오는가,
  숨긴 계정으로 연결된 자리·계정 없이 사람만 확인된 자리가 규칙대로 나오고 빠지는가.

---

## 6. 기존 데이터 옮겨 담기

### 롤

| 지금 | 건수 | 새 자리 |
|---|---|---|
| 위키 시드(시리즈→대회) | 875 | 그대로. `collected_via=manual`, format `tournament` |
| VOD 판독, 시리즈 경로 | 681 | kind → format: ck→ck, land→land, tournament→tournament, other→unclassified |
| VOD 판독, 행사 직접(시리즈 없음) | 303 | 같은 행사 아래 **한 판짜리 시리즈**(§10 결정 6) |
| 엑셀(행사 있음) | 25 + 수동 생성 1 | format ck |
| 엑셀(시리즈만, 행사 없음) | 251 (81시리즈) | 엑셀 날짜별 CK 행사(결정 16, §10 결정 7) |
| 엑셀(둘 다 없음) | 102 (숨김 20) | 날짜별 CK 행사 아래 한 판짜리 시리즈. 숨김 20 은 숨김 유지 |
| 토너먼트 코드 | 829 | `collected_via=api`, `scope=versus`, §3.4 의 날짜별 자동 미분류 묶음 |
| 공개 큐, 솔랭 도전 범위(두 계정·420·2026-08-21~) | 110 | `scope=personal`. 상세는 두 계정만 |
| 공개 큐 그 외 | 26,925 + 쓰레기 7 | **삭제** |
| kind `other` 행사 | 35 | format `unclassified`(경기 없는 2개는 삭제). 사용자가 다시 지정 |
| 보너스 | 43 | 그대로 |

### FC

| 지금 | 건수 | 새 자리 |
|---|---|---|
| 스트리머끼리 API 경기, 행사 있음 | 106 (+화면 판독 쪽 연결) | 행사 format: tournament·ck 그대로, showmatch→concept, scrim(4행사)→unclassified + 사용자 지정 |
| 스트리머끼리, 행사 없음 | 1,391 (casual 224 · unresolved 536 · 미조사 631) | §3.4 의 (두 사람, 날짜) 자동 미분류 묶음. casual 판단은 **친선으로 옮기지 않는다**(§10 결정 4) — 메모는 이력으로 |
| 한쪽만 스트리머 | 2,937 | §10 결정 3 |
| 화면 판독(숨김) | 332 | 같은 규칙. API 경기와 합친 104건은 API 쪽이 시리즈·행사를 가진다 |
| 시리즈 | 5 | 그대로 |
| 포함/제외 결정 | 162 (include 154 · exclude 8, 모두 auto) | include 는 이미 소속과 같으므로 이력으로. exclude 8 은 `event_exclusion`(`decided_by='auto'`)으로 — 판은 묶음으로 |

### 검수 상태 지키기

- 판을 시리즈로 옮기면 트리거가 검수 완료를 푼다(`invalidate_match_review`, `invalidate_series_review`). 0079 처럼 **완료 상태를 먼저 잡아 두고
  이관 뒤 되돌린다**. 분류만 옮길 뿐 경기 값은 그대로이므로 완료를 유지하는 것이 맞다. 롤 완료 863건이 대상.
- `review_change` 의 시리즈 키 주소(74+103행)와 셀 잠금은 키를 바꾸지 않는 한 유지된다 — **기존 시리즈 키는 바꾸지 않는다**. 새로 만드는 한 판짜리 시리즈만 새 키(`set:<match_id>`).
- 되돌린 뒤 **검수 완료 경기 ID 집합**과 **셀 잠금 집합**이 이관 전과 같아야 한다(수가 아니라 집합, §8 대조).

---

## 7. 지울 것

| 대상 | 대체 |
|---|---|
| `lol_match_category` 3·4인자, `metrics/category.ts` 의 분류 목록·큐 표·`expandCategory`·`PUBLIC_QUEUE_CATEGORIES` | `event.format` + `match.map` |
| `event.kind`, `EVENT_KIND_LABEL`, 행사 종류 목록 12곳 | `event.format`, `metrics/format.ts` |
| `match.event_id`, `match_series_owns_event`, `COALESCE(ms.event_id, m.event_id)` 약 40곳 | 시리즈 경유 한 길 |
| `match.source`, `match.origin` | `collected_via` |
| `streamer_encounter.category`, `champion_stat.category`(또는 두 표 자체) | 뷰 계산(§5.1) |
| `fco_match_context`, `fco_event_match_decision`, FC 상태 계산 7곳 | 행사 format + 이력 |
| `core_public` 의 `lol_*_all_modes`·`match`·`aram_match`·`match_with_bonus`·`streamer_encounter`·`aram_encounter`·`tournament_match` 등 | `versus_set`·`versus_pair_set`·(목록용) `versus_set_with_bonus` |
| `metrics/match-tally.ts` 의 랜드 분기, SQL 다수결 3곳, `buildOpponentHistory`, `RecordBar`, 미사용 연도 함수 | `metrics/tally.ts`, `RecordPair` |
| 계정 연결 시 자동 백필 등록, `ingest_cursor`(전원), 실시간 엔진의 전원 순회 | `collection_target` |
| 참가자 버림 칸 8개, match 버림 칸 4개 | — |
| 커밋된 임시 질의 `scripts/_dup.mjs`·`_dup2.mjs`·`_q27.mjs` | — |

---

## 8. 진행 단계

운영 DB 를 건드리는 것은 4단계 하나뿐이다. 그 전까지는 메모리 DB 와 운영 복사본에서만 한다.

| 단계 | 내용 | 끝 조건 |
|---|---|---|
| 0 | 이 문서 확정 — §10 결정, 검토(Codex 등) | 결정 표가 다 채워짐 |
| 1 | **뼈대 시험**: 새 스키마를 PGlite 에 세우고 불변식 검사(`verify:db` 새 단언) · `versus_set`/`tally` 기능 검사. 속도는 운영과 같은 버전 PostgreSQL 의 운영 복사본에서(§5.1 기준) | 잘못된 행이 전부 거부되고, 속도 기준 통과 |
| 2 | **코드 전환**(한 가지 뼈대 위에서): 쓰기 경로(ck-merge·검수 actions·시드·FC 수집/맥락·워커·일괄 등록 도구) · 읽기 경로(공개·관리 화면, contract, 모듈) · 스킬·프롬프트 문장 · 검사. 옛 구조 참조 0 | `npm test`·`verify:*` 전부 통과, 정적 검사로 옛 칸 참조 0 |
| 3 | **리허설**: 운영 DB 복사본(덤프)에 이관 마이그레이션을 돌리고 아래 **대조**를 전부 통과시킨다. 되돌리기도 리허설한다(백업 복원 → 옛 커밋으로 대조) | 의도하지 않은 차이 0 |
| 4 | **전환** — 아래 절차 | 대조 통과, 운영 화면 정상 |
| 4b | **디스크 회수**(별도 작업): 전환이 안정된 뒤 참가자 표를 백업·TRUNCATE·다시 넣기(트리거 끈 채로 — 10/12 방식). 구조 전환과 섞지 않는다 | Supabase 에서 크기 감소 확인 |
| 5 | **관찰·정리**: 자동 조사 첫 결과 사람 확인, 미분류·엑셀·other·scrim 재지정(사용자), CLAUDE.md "지금 단계"·SERIES-EVENT-MODEL·CK-COLLECTION·SETUP 갱신 | 문서 숫자가 실측과 같음 |

**대조 (3·4단계)** — 건수가 아니라 ID·값 집합으로 비교한다:
- 남는 경기 ID 집합 = 이관 전 집합 − 삭제 목록(공개 큐 26,925 + 쓰레기 7, 목록 파일로 고정). 삭제 목록 밖의 경기가 하나라도 없어지면 실패.
- 남는 경기마다 참가자 기본 칸 값(§3.6 기본 칼럼 전부), `set_role`·`set_label`, `visibility`, 시리즈 키·세트 번호(새 한 판짜리 시리즈 제외)가 같다.
- 각 판의 진행 방식이 §6 표의 대응대로다(옛 kind → 새 format 매핑 표를 검사가 그대로 적용해 본다).
- 검수 완료 경기 ID 집합, `reviewed_at` 집합, 셀 잠금(`review-lock`) 집합이 같다.
- `event_exclusion` 이 옛 결정 표의 최신 exclude 와 같다.
- 상대전적 대칭: 모든 (A, B) 쌍에서 A 기준 승·무·패 = B 기준 패·무·승.
- 공개 집계는 이번에 결함을 고치므로 전후가 같을 수 없다. **의도한 차이 목록**(공개 큐 삭제분, 보너스·양쪽 몰수 처리, 미상 표시, 숨김 계정 규칙)을 미리 적고, 그 목록으로 설명되지 않는 차이를 실패로 본다.

**전환 절차 (4단계)**:
1. 쓰는 진입점 전부 정지 — 타이머(ck-auto·fco·fco-club·fco-rating·fco-prices·schedule·worker·t7 등 DB 쓰는 것), 개발 서버(운영 DB 를 쓰는 관리자 화면), 수동 백필.
   이 PC 의 웹은 개발 서버뿐이라(배포 전) 앱 버전은 저장소 커밋 하나로 정해진다.
2. 실행 중인 작업이 끝났는지 확인(`job_run` running 0, 조사 잠금 획득, 프로세스 목록) — 끝나지 않았으면 기다리거나 중단한다.
3. 백업 — 바뀌는 표 전부를 덤프하고 경기 삭제 목록과 함께 보관(T7). 되돌리기는 이 덤프 복원 + 옛 커밋 checkout.
4. 같은 커밋의 마이그레이션 적용 — 옛 칼럼(`match.event_id`·`source`·`origin`·`event.kind` 등)을 같은 트랜잭션에서 지워, 혹시 남은 구버전 코드는 조용히 쓰지 못하고 **실패**하게 한다.
5. 검수 완료 되돌리기 → 대조 실행.
6. 대조가 실패하면 3번 덤프로 복원하고 옛 커밋으로 돌아간다(부분 수정해서 앞으로 밀지 않는다).
7. 통과하면 새 커밋으로 개발 서버·타이머 재개, 첫 자동 실행들의 결과를 확인한다.

- 2·3단계 사이에 자동 조사가 옛 구조로 계속 쓰므로, 리허설 덤프는 전환 직전에 다시 뜬다.
- 마이그레이션 번호는 전환 시점의 `db:migrate --status` 로 정한다(지금 다음 번호 0089). 남의 번호가 대기 중이면 먼저 묻는다.
- 디스크: 참가자 표가 약 220MB → 수십 MB, DB 전체 547MB → 약 310MB 로 추정(4b 뒤). Supabase 에서 파일 크기가 실제로 줄었는지 4b 뒤 잰다.

---

## 9. 위험과 대응

| 위험 | 대응 |
|---|---|
| 검수 완료가 대량으로 풀린다(442경기 사고와 같은 모양) | §6 잡아 두기·되돌리기, 리허설에서 완료 수 대조 |
| 지운 공개 큐 판은 되살릴 수 없다(2년 보존 밖은 영구) | 사용자 결정 13. 전환 전 해당 행 백업 파일을 보관 위치(T7)에 남긴다 |
| 공개 큐 판만 있던 스트리머 86명의 롤 기록이 사라진다 | 스트리머 목록·프로필에서 내전 기록이 없는 사람을 어떻게 보일지는 화면 노출 정리 문서에서 정한다 |
| 자동 조사 문장 변경이 조사 품질을 바꾼다 | 바뀐 문장 목록 + 첫 실행들 사람 확인. 정의 자체가 바뀌는 변경이라 자동화 재설계 §9-6 의 "원문 이동" 규칙 대상이 아님을 명시 |
| 자동 묶음이 실제와 다르다 | 묶음은 그릇일 뿐 분류가 아니다(format=unclassified). 사람이 시리즈를 실제 행사로 옮기면 된다. 키 함수는 core 하나 + 단위 시험(입력 순서를 뒤섞어도 같은 결과) |
| 전환 중 쓰기 충돌·구버전 코드 | §8 4단계 — 쓰는 진입점 전부 정지, 실행 중 작업 종료 확인, 옛 칼럼은 같은 트랜잭션에서 지워 구버전 코드가 조용히 쓰지 못하고 실패하게 한다 |

---

## 10. 정할 것

| # | 질문 | 추천 | 다른 안 |
|---|---|---|---|
| 1 | 미분류의 그릇 | **행사 필수 + 자동 미분류 묶음 행사**(§3.4) — 미분류 표현이 하나 | 시리즈의 행사를 비워 두면 미분류 — "행사는 있는데 형식 모름"과 "행사 없음" 두 표현이 생긴다 |
| 2 | 자동 묶음 기준 | **순서 무관한 결정적 키**(§3.4): FC (두 사람, KST 날짜), 토너먼트 코드 KST 날짜. 사람은 묶음을 relabel 하지 않고 시리즈를 실제 행사로 옮긴다 | 시간 간격 기준(40분·2시간) — 늦게 들어온 판에 따라 묶음이 합쳐지거나 갈라져 재실행 결과가 달라진다. Codex 검토로 폐기 |
| 3 | FC 한쪽만 스트리머인 경기 2,937판(공식경기 50 의 995/1,000 포함) | **`personal`** — 내전 집계·필터에서 빠지고, 앞으로도 수집은 하되(넥슨 30일 한계) 개인 기록 화면에서만 | 지금처럼 FC 요약에 포함 / 롤처럼 지명만 수집하고 기존 삭제 |
| 4 | FC casual 238건 | **미분류**(결정 7 "확인된 것만"). 사람이 확인한 판단 0건, 149건은 "단서 없음" 부재 근거뿐, 64건은 연습·대비 등 다른 분류 후보 | 친선으로 옮김 |
| 5 | 조우·챔피언 통계 파생 표 | **뷰 계산으로 폐지**, 1단계 속도 측정 후 확정 | 파생 표 유지(숨긴 계정 반영·재계산 경로를 고쳐서) |
| 6 | VOD 행사 직접 경로 303판 | **한 판짜리 시리즈**(묶음을 지어내지 않는다) | 행사마다 한 시리즈로 묶기 |
| 7 | 엑셀 CK 의 행사 단위 | **엑셀 날짜별 CK 행사 하나** | 엑셀 시리즈마다 행사 |
| 8 | 롤 `scrim`·FC 의 허용 목록 | §3.2 표대로(FC 에 스크림 없음 → FC scrim 4행사는 사용자 지정) | FC 에도 스크림 허용 |

Codex 검토 의견(2026-10-16): 1·3·4·6·7 추천안 동의, 2 는 결정적 키로 보완 뒤 확정, 5 는 성능 측정 조건부, 8 은 서비스 분류 정책으로 확정.

**확정(2026-10-16 사용자): 1·2·3·4·6·7·8 은 추천안대로. 5 는 1단계 성능 측정으로 확정 — 측정 통과(§11), 파생 표 폐지.**

---

## 11. 1단계 결과 (2026-10-16)

기존 코드는 한 줄도 바꾸지 않았다(자동화 타이머가 작업 트리를 그대로 실행하므로). 더한 것은 새 파일뿐이다:

| 파일 | 내용 |
|---|---|
| `db/drafts/classification_skeleton.sql` | 이관 마이그레이션 초안. `db/migrations` 밖이라 `db:migrate` 가 적용하지 않는다. 전환 때 번호를 붙여 옮긴다 |
| `packages/core/lib/metrics/format.ts` | 진행 방식 목록·게임별 허용·칩 순서·라벨(미분류는 칩 "분류 전", 라벨 없음). `concept` 의 화면 이름은 "컨셉" |
| `packages/core/lib/metrics/tally.ts` (+ `tally.test.ts` 5건) | 세트·시리즈 세기, 미상 판정표, 상대전적 결과 짝표, 대칭 |
| `scripts/verify-skeleton.ts` (`npm run verify:skeleton`) | 메모리 DB 에 옛 구조로 실제 경우를 넣고 초안 적용 → **34건** 대조·불변식·공개 뷰·트리거 검사 |
| `scripts/skeleton-rehearsal.ts` | 운영 데이터를 **읽기 전용 트랜잭션**으로 복사해 이 PC 의 일회용 PostgreSQL 17.6(운영과 같은 버전)에 초안을 돌린다 — 3단계 리허설에도 그대로 쓴다. 실행: `CK_PG_BIN=<pg17 bin> node --env-file=apps/web/.env.local scripts/skeleton-rehearsal.ts` |

**운영 복사본 리허설** — 경기 34,875 · 참가자 31,717(지울 공개 큐 판의 참가자는 읽지 않음) · FC 참가자 9,532 · 판단 이력 42,237:
- 대조 6건 전부 통과: 남은 경기 ID = 전 − 삭제 목록(26,932), 참가자 기본 칸·보너스·숨김·검수 완료·버전·잠금·FC 맥락 확인·기존 시리즈 키·옛 review_change 가 해시까지 같다, 제외 표 = 옛 결정의 최신 exclude.
- 공개 세트 23,902행(롤 20,892 · FC 3,010). 모든 사람·맵 탭에서 "전체 = 칩 합" 성립, 상대편 짝 94,486행 대칭, 결과 모순 0쌍.
- 옮겨 담은 뒤: 롤 행사 ck 173(엑셀 날짜 행사 포함)·land 37·tournament 33·미분류 33 + 토너먼트 코드 날짜 묶음 115 / FC ck 8·concept 2·tournament 8·미분류 4(옛 scrim) + (두 사람, 날짜) 묶음 638. FC 개인 기록 2,921 + 화면 판독 숨김 235.
- **속도**(5회 중앙값, 색인 추가 없음): 프로필 요약 24ms · 매치 히스토리 31 · 상대 전적 탭 78 · 상대전적 상세 68 · 챔피언 탭 22 · FC 요약 10 · 스트리머 목록 47 · 홈 숫자 53 · 사이드바 자주 만난 매치업 144 · 행사 날짜 10 · 경기 상세 2 · 솔랭 도전 21 — 전부 200ms 이하. → **§10 결정 5 확정: 조우·챔피언 통계 파생 표를 없애고 뷰로 계산한다.**

**시험이 찾아 고친 것** (설계에 반영):
1. 롤·FC 를 이어 붙인(UNION) 공개 세트 뷰를 상대전적에서 자기 자신과 다시 이으면 "같은 경기의 상대"를 색인으로 못 찾는다(상대전적 상세 **9초**). → 게임마다 평평한 뷰(`lol_versus_set`·`fc_versus_set`)를 두고 `versus_set` 은 둘을 이은 것, 상대전적은 게임별로 같은 경기 안에서만 잇는다. 공개 규칙("누구로 확인됐나")은 게임마다 그 뷰 한 곳에만 있다.
2. 시리즈 첫 판 날짜를 전체 집계로 매번 만들면 느리다 → 결과 행에만 계산되는 상관 부질의(기존 `(series_id, series_game_no)` 색인).
3. 대진표 칸 트리거(`event_slot_match_same_event`)가 지운 `match.event_id` 를 읽고 있었다(plpgsql 은 실행 전까지 오류가 안 난다) → 시리즈 경유로 다시 썼고, DB 함수 본문 전체에서 지운 칸·표 참조를 찾는 검사를 넣었다.
4. 같은 시각(한 트랜잭션)의 포함·제외 결정은 순서가 갈리지 않는다 → 같은 시각이면 사람의 결정이 이긴다.
5. 롤 검수 무효화가 보너스 지정(`set_role`·`set_label`) 변경에 반응하지 않았다(조사 D) → 값 변경 목록에 넣었다.

**남은 것(2단계로)**: FC 개인 기록의 공개 경로(지금 FC 공개 화면은 `fconline.ts` 가 원본 표를 직접 읽는다 — 2단계에서 `core_public` 로 옮길 때 정한다),
`fco_context_evidence` 의 게임 공통 근거 표 일반화, `mod_versus.pair`(아무도 안 읽는 매시간 재계산) 삭제, 쓰기·읽기 경로 전환.
★ 2단계는 작업 트리를 자동화가 그대로 실행하므로 **별도 브랜치(worktree)** 에서 해야 한다 — 그 전에 지금 작업 트리의 미커밋 변경을 커밋해 두어야 브랜치가 그 위에서 시작한다.


---

## 12. 2단계 계약 (코드 전환 — 브랜치 `classification-skeleton`)

모든 전환 작업이 이 계약 하나를 따른다. 계약에 없는 것이 필요하면 바꾸지 말고 보고한다.

### 12.1 스키마(0089 뒤)
- `event.format` NOT NULL(게임별 허용 — `metrics/format.ts` = DB CHECK), `event.auto_bucket`. `event.kind` 없음.
- `match_series.event_id` NOT NULL, (event_id, game_code) 복합 FK. `match.event_id` 없음 — 행사는 **시리즈 경유 한 길**.
- `match.scope` NOT NULL(`versus` = 시리즈 안 내전 세트 / `personal` = 시리즈 밖 개인 기록), `match.map`(롤 생성 칼럼 rift·aram·unsupported, FC NULL),
  `match.collected_via`(api·vod·manual). `match.source`·`origin`·`game_type`·`game_start`·`game_end`·`has_timeline` 없음.
- `match_participant` 는 기본 칸만. 상세는 `lol_participant_detail`(지명 계정만).
- 없어진 것: `lol_match_category`, `streamer_encounter`·`champion_stat`(파생 표), `ingest_cursor`, `fco_match_context`, `fco_event_match_decision`,
  `schedule_entry.planned_kind`(→ `planned_format`), core_public 의 옛 뷰(`match`·`match_with_bonus`·`aram_*`·`streamer_encounter`·`champion_stat`·
  `match_participant`·`match_lineup`·`streamer_match`·`tournament_match`·`lol_*_all_modes`).
- 새 표: `collection_target`(지명 수집), `event_exclusion`(현재 제약), `review_change.entity` 에 `classification`.

### 12.2 쓰기 — `packages/core/lib/db/classification.ts` 만
`ensureEventInTx`(찾기·만들기, 기존은 대조만) · `updateEventInTx`(주인만) · `ensureAutoBucketInTx` + `lolCodeBucketSlug`·`fcPairBucketSlug` ·
`ensureSeriesInTx` · `placeSetInTx`·`placeSingleSetInTx`(판을 시리즈에 두는 유일한 길 — 제외 확인·게임 대조) · `moveSeriesInTx` ·
`assertAttachAllowedInTx`·`excludeFromEventInTx` · `dropEmptySeriesInTx`. 판을 행사·시리즈에 붙이는 SQL 을 다른 곳에 쓰지 않는다.
- 자동 경로(수집·자동 조사)는 `actor: 'auto'`, 사람(검수 화면·사람이 돌리는 CLI)은 `'admin'`.
- 행사 없이 들어오는 내전 판: 토너먼트 코드 → `lolCodeBucketSlug`, FC 스트리머끼리 → `fcPairBucketSlug` 묶음에 한 판짜리 시리즈.
  사람은 묶음을 relabel 하지 않는다(`updateEventInTx` 가 거부) — 시리즈를 실제 행사로 `moveSeriesInTx`.
- 파생 표가 없으므로 재파생·재계산 호출(`rederiveEncountersInTx`·`recomputeChampionStatsInTx` 등)은 지운다.

### 12.3 읽기 — 공개 집계는 이것만
- `core_public.versus_set`(= `lol_versus_set` ∪ `fc_versus_set`, 한 행 = 사람×본게임 세트, format·map·series_started_on 포함),
  `core_public.versus_pair_set`(같은 판의 두 사람, relation teammate/opponent), `core_public.personal_game`(개인 기록 — 솔랭 도전),
  `core_public.match_detail`(롤 경기 하나 — 보너스 포함), `core_public.event`·`event_dates`(format).
- 세기: `metrics/tally.ts` 의 `tally`(세트·시리즈), `pairSetOutcome`(상대전적 한 세트), `mirror`. 다수결·랜드 규칙을 다른 곳에 두지 않는다.
- 분류: `metrics/format.ts`(`FORMATS_BY_GAME` 칩 순서, `formatChipLabel`, `formatLabel` — 미분류는 라벨 없음).
- 화면 규칙: 필터 = `전체` + 게임별 진행 방식 칩(마지막 "분류 전"). 한 맵 탭 안에서 전체 = 칩 합. 보너스 판은 집계 제외(펼친 목록에만).
  세트와 시리즈는 **항상 같이** 보인다. 기간 필터는 `series_started_on`. 롤 맵 탭(협곡/칼바람) — 칼바람은 진행 방식으로 나누지 않는다.
  상대전적은 언제나 대칭(`pairSetOutcome`). 승+무+패+미상 = 판 수, 미상이 있으면 보인다.

### 12.4 영역과 파일 소유 (같은 파일을 두 영역이 고치지 않는다)
| 영역 | 파일 |
|---|---|
| **A 롤 쓰기·검수** | `packages/core/lib/db/`의 ck*.ts·tournaments.ts·match-series-review.ts·match-review.ts·match-overview.ts·event-review.ts·review-*.ts·lol-review-scope.ts·participant.ts·admin-history.ts·puuid-move.ts·event-bracket.ts·tournaments 관련, `metrics/`의 ck-*·series-check·set-label·review-*, `apps/web/app/admin/**`(fco·office 제외), `apps/web/components/admin/**`(Fco*·office 제외), `apps/web/lib/`의 admin-*·lol-review-list·ck-*·vod-*, `scripts/`의 ck-merge.mjs·ck-record*·seed-tournament.ts·ck-queue.ts·bracket-apply.ts·repair-*, verify-ck*·verify-admin*·verify-match-review*·verify-review*·verify-bracket*·verify-tournaments.mjs·verify-aram-upgrade.ts, `scripts/lib/verify-match-series.ts`·`verify-review-progress.ts` |
| **F FC** | `packages/core/lib/games/fconline/**`, `packages/core/lib/db/fconline*.ts`, `apps/web/app/admin/fco/**`, `apps/web/components/admin/Fco*`, `apps/web/app/fc/**`, `apps/web/components/fco-*`, `apps/web/lib/fco-*`, `packages/ui/fc/**`, `packages/modules/fc_*/**`, `scripts/fco-*.ts`, `scripts/verify-fco*.ts`, `metrics/club-*` |
| **R 롤 공개 읽기** | `packages/core/lib/db/`의 public.ts·personal.ts·opponent-history.ts·public-tournaments.ts·public-ranked.ts·profile-links.ts·known-names.ts·types.ts, `packages/core/lib/contract/**`(schedule.ts 제외), `metrics/`의 category.ts·match-tally.ts·opponent-history.ts·opponents.ts·record-*.ts·event.ts·placement.ts·affinity.ts, `packages/modules/`의 versus·tournaments·solo_challenge, `packages/ui/`(fc 제외), `apps/web/app/`의 lol/**·page.tsx·[...path]/**, `apps/web/components/`(admin·fco 제외) |
| **K 수집·편성표** | `apps/worker/**`, `packages/core/lib/db/`의 ingest.ts·streamers.ts·watchlist.ts·schedule*.ts, `packages/core/lib/ingest/**`, `packages/core/lib/riot/**`, `packages/core/lib/contract/schedule.ts`, `metrics/schedule.ts`, `packages/modules/schedule/**`, `scripts/schedule-notices/**`, `scripts/`의 verify-ingest.ts·fake-riot.ts·seed-streamers.ts·identify-candidates.ts·verify-schedule*, `ops/jobs/`(worker-loop·lol-rank) |
| **본 세션** | `db/migrations/`, `classification.ts`·`format.ts`·`tally.ts`, `scripts/verify-db.ts`·`verify-skeleton.ts`·`skeleton-rehearsal.ts`·`verify-modules.ts`·`lib/consistency-checks.ts`, `.claude/skills/**`, `scripts/ck-auto.sh`·`ck-backfill.sh`(프롬프트), 문서·CLAUDE.md |

ingest.ts 의 재파생 함수는 K 가 지우고, 그 호출부는 각 파일의 소유 영역이 지운다(병합 때 맞춘다).

---

## 13. 2단계 결과 (2026-10-16, 브랜치 `classification-skeleton`)

네 영역(롤 쓰기·검수 / FC / 롤 공개 읽기 / 수집·편성표)을 따로 전환해 합쳤다. 운영 작업 트리·운영 DB 는 건드리지 않았다
(운영 DB 는 리허설 복사에만 읽기 전용으로 읽었다).

**확인** — 타입 검사 5개 프로젝트 오류 0 · `npm test` 660/660 · `verify:db`(검사 242, 실행 399건) · `verify:skeleton` 40 · `verify:ingest` ·
`verify:automation` · `verify:fco`·`fco-dates`·`fco-club`·`fco-screen`·`fco-screen-review`·`fco-context` · `verify:bracket` · `verify:admin` ·
`verify:ck`·`ck:concurrency`(실 PostgreSQL)·`ck:pov`·`ck:cell-lock` 통과. `verify:modules` 의 옛 분류 이름 0건(남은 위반은 다른 작업의
`schedule.css` 글자 크기 12건). `verify:ck:backfill` 은 바꾸기 전 코드에서도 같은 단언으로 실패한다(이번 변경과 무관 — 따로 본다).
브라우저 검사(`verify:ck:browser`·`review:browser`)는 이번에 돌리지 않았다.

**운영 복사본 리허설**(PostgreSQL 17.6) — 대조 9건 통과(경기 ID·참가자 기본 칸·검수 완료·잠금·시리즈 키·이력 해시·제외 표·칩 합·대칭),
0089 적용 5.7초. **실제 화면 함수 17개 전부 200ms 이하**(가장 느린 것: 상대전적 상세 148ms, 챔피언 탭 135ms, 홈 숫자 95ms).

**통합에서 찾아 고친 것**
1. 상대전적 뷰를 평범한 자기 조인으로 두면 판이 적은 맵(칼바람)에서 신원 규칙을 판마다 참가자 전체에 다시 계산하는 계획이 골라졌다
   (실제 화면 함수 3.5~8초 — 흉내 질의로는 안 보였다). → 상대는 기준 판의 판 번호로만 찾는다(LATERAL). 전체 집계(홈 조우 수, FC 맞대결
   순위)는 짝을 만들지 않고 공개 세트에서 판 단위로 센다.
2. 0089 가 옛 "공개 큐 판은 Riot 경기 번호 필수" 제약을 지우고 새 칸으로 다시 걸지 않았다 → `match_lol_api_has_riot_ids`.
3. 경기 보기(`match_detail`)에 아레나·우르프 판이 나왔다 → 0078 정책대로 뺐다.
4. 분류 이동(scope·시리즈)이 FC 경기값 검수를 풀었다 → scope 는 값 목록에서 뺐다.
5. FC 를 개인 기록으로 되돌리는 쓰기·옮긴 뒤 빈 자동 묶음 정리(`releaseToPersonalInTx`, `moveSeriesInTx`).

**사용자에게 보이는 변화(전환 뒤)** — 롤: 협곡/칼바람 맵 탭, 진행 방식 선택(전체·CK·대회·컨셉·스크림·랜드·솔랭내기·분류 전), 승패 자리마다
세트+시리즈, 랜드는 시리즈 하나, 맞라인은 세트마다, 대회 탭이 기간 필터를 따름, 홈 숫자는 공개 내전 기준(크게 준다), 공개 큐 판만 있던
86명은 롤 기록이 비고 솔랭 도전만 남는다. FC: 진행 방식 선택(전체·대회·CK·컨셉·친선·분류 전) + 경기 모드 보조, 양쪽 몰수는 무,
"일반 경기" 라벨 없음, 한쪽만 스트리머인 판은 새 "개인 기록" 탭에만(스쿼드 표도 내전 세트만이라 크게 준다). 관리자: 검수 대기열에
"분류 대기" 갈래(자동 묶음 판), 자동 묶음은 relabel 불가, 출처 라벨은 API·영상 판독·수기. 조사 결과·시드 파일은 `event.format`(옛 `kind` 거부).

**남은 것**
- 지명 등록 도구가 없다(함수 `addCollectionTarget` 만). 솔랭 도전 화면은 아직 `challenges.json` 의 계정·시작일을 읽는다 — `collection_target`
  을 정본으로 삼으려면 공개 읽기 경로가 필요하다.
- FC 개인 기록의 `core_public` 뷰가 없다(지금은 같은 신원 규칙으로 원본을 읽는다).
- 비어 있는 `mod_versus.pair` 표 삭제, `fco_context_evidence` 의 게임 공통 일반화.
- 운영에 있는 시드 파일(`seed/tournaments*.json`, 저장소 밖)의 `kind` → `format`.
- 3단계: 전환 직전 덤프로 리허설 다시 · 4단계 전환 절차(§8).

---

## 14. 전환 (2026-10-16 15:45~15:50 KST)

- 쓰는 진입점 정지: 타이머 12개 일시 정지(stop — 설치는 그대로), 진행 중이던 롤 목록 확인 종료 대기, 개발 서버 정지(사용자 터미널에서 띄운 것).
- 운영 작업 트리를 `classification-skeleton` 으로 앞으로 감기(다른 세션의 미커밋 변경 9개는 겹치는 파일 없음 — 그대로 남김).
- 운영 DB 미리보기(`scripts/cutover-0089.ts`, 되돌림): 0089 53초 + 대조 21초, 대조 전부 통과.
- **`--apply`**: 백업 표 70개·1,264,307행(`/mnt/d/soop-lol-backup/0089-202610161545`, 85MB, 2분 24초) → 0089 45초 → 대조 통과 → 커밋(61.7초).
  경기 34,875 → 7,943(공개 큐 26,932 삭제) · 공개 세트 23,902 · 상대편 짝 94,486 — 리허설과 같은 숫자.
- 첫 시도는 백업에서 28분 멈췄다(postgres.js COPY 스트림을 한 번 쓰면 같은 연결의 다음 질의가 멈춤 — 운영 DB 무변경). 커서·JSON 줄 백업으로 고쳐
  40만 행 왕복 지문 일치를 확인한 뒤 다시 돌렸다.
- 전환 뒤: 대량 삭제 뒤 통계가 낡아 첫 화면 질의가 느렸다(홈 9.9초) → 관련 표 `ANALYZE` 뒤 운영 DB 기준 42~498ms(네트워크 포함).
  타이머 재개, `verify:automation --host` 통과, 첫 실행: FC 티어·일정 수집 완료, 일정 분석은 기존 잠금 충돌(일정 수집과 동시 시작), DB 사용량
  점검은 오늘 10:00 의 쓰기 실패 표시(전환 전 — 운영 DB 가 잠시 읽기 전용이었다) 때문에 설계대로 멈춤.
- DB 크기 547MB → 476MB(파일 공간은 아직 — 4b 디스크 회수는 따로).
