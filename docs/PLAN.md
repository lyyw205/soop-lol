# soop-lol — 설계 문서

SOOP 스트리머들의 롤 데이터를 모아 **커리어**와 **스트리머 간 관계(상대전적·맞라인·상성)**를 보여주는 사이트.

- 사전 조사 → [RESEARCH.md](RESEARCH.md)
- 내전 수집 확장 설계 → [TOURNAMENT-CODE.md](TOURNAMENT-CODE.md)

---

## 0. 한 문장 정의

> **개인 전적은 이미 여러 곳이 한다. 우리는 "스트리머끼리 누가 누구를 이겼나"를 한다.**

lolsoop / sooplol / 덥덥미는 전부 개인 전적의 나열이다.
**관계 데이터**가 우리 해자다. 이 문장에서 벗어나는 기능은 전부 후순위다.

---

## 1. 확정된 전제

| 항목 | 결정 | 근거 |
|---|---|---|
| 1차 수집 범위 | **공개 큐만** (솔랭/자유랭/일반/칼바람/클래시) | Production Key 승인 없이 즉시 시작 |
| 내전 수집 | **2단계로 미룸.** 스키마만 미리 확보 | 커스텀 게임은 API로 조회 불가 → 토너먼트 코드 필요 |
| MVP 첫 화면 | **스트리머 프로필/커리어** | 사용자 선택 |
| 수집기 운영 | **AWS** | 사용자 선택 |
| 계정 매핑 | 수동 시드 → spectator 기반 후보 발굴 → 제보 | 공개 데이터셋이 존재하지 않음 |

### 아직 안 정해진 것 (진행하며 확정)

- [ ] 대상 스트리머 규모 (30명? 300명?) — **백필 비용과 인프라 사이즈가 여기서 갈린다**
- [ ] 치지직/유튜브 확장 여부 — 스키마는 `platform` 컬럼으로 열어둠
- [ ] 큐 범위 (솔랭만? 칼바람·아레나까지?) — 스키마는 전부 수용, 화면 필터로 제어
- [ ] VOD 타임스탬프 연동 — §9 참조. **하면 킬러 기능**
- [ ] 수익화 — Riot 정책상 데이터 판매 불가, 광고는 가능

---

## 2. 도메인 모델 — 핵심 통찰

```
스트리머(사람)  1 ──── N  라이엇 계정(puuid)
                              │
                              │ N
                              ▼
                        경기 참가(match_participant)
                              │
                              │ 같은 경기에 스트리머가 2명 이상이면
                              ▼
                        ★ streamer_encounter ★
                        (상대전적 · 맞라인 · 상성의 유일한 원천)
```

**세 가지 설계 결정이 전부를 좌우한다.**

### 결정 1 — `puuid`가 유일한 불변 키다

Riot ID(`닉네임#태그`)는 **바뀐다.** `summonerId` / `accountId`는 Riot이 단계적으로 폐기 중이다.
→ 모든 조인은 `puuid`. Riot ID는 표시용 캐시일 뿐이며 하루 1회 갱신한다.

### 결정 2 — 스트리머와 계정을 분리하고, **매핑에 근거를 남긴다**

부계정 노출은 실제 분쟁이 된다. `streamer_account`는 단순 매핑 테이블이 아니라 **증거 테이블**이다.

- `evidence` (jsonb) — 어떻게 알았나 (클립 URL, 공지, 제보자)
- `confidence` — `verified` / `likely` / `unverified`
- `visibility` — 본인 요청 시 즉시 숨김
- `active_from` / `active_to` — 계정 양도·폐기 대응

> 화면에 `confidence`를 노출한다. `unverified`를 확정처럼 보여주지 않는다.

### 결정 3 — `streamer_encounter`를 파생 테이블로 **미리 만든다**

"두 스트리머가 같은 경기에 있었다"는 사건은 전체 경기 중 **극소수**다.
매번 100만 행짜리 `match_participant`를 self-join 하는 건 낭비다.

매치가 적재될 때 워커가 파생시킨다. 상대전적 페이지는 이 테이블 하나만 읽는다.
정규화 규칙: **항상 `streamer_a_id < streamer_b_id`** (CHECK 제약) → 쌍 중복 원천 차단.

> ⚠️ **재파생 잡이 반드시 필요하다.**
> 스트리머가 나중에 추가되면, 그 puuid가 참여한 **과거 match_participant를 훑어**
> encounter를 다시 만들어야 한다. 이걸 빼먹으면 신규 등록 스트리머의 상대전적이 영원히 0이다.

---

## 3. 테이블 목록

전체 DDL은 [`db/schema.sql`](../db/schema.sql).

### 아이덴티티
| 테이블 | 역할 |
|---|---|
| `streamer` | 스트리머(사람). slug, 표시명, SOOP ID, 플랫폼, 공개 여부 |
| `riot_account` | 라이엇 계정. **PK = puuid**. Riot ID 캐시, 동기화 커서 |
| `streamer_account` | 매핑 + **증거**. confidence / evidence / visibility / 유효기간 |
| `account_candidate` | spectator로 발굴한 후보 큐. 관리자 승인 전 대기 |

### 경기
| 테이블 | 역할 |
|---|---|
| `match` | 경기 1건. `source`로 공개큐/내전/수기 구분 |
| `match_participant` | 참가자 10명. 포지션·챔피언·스탯·`challenges` jsonb |
| `event` | 내전/대회 묶음 (2단계 + 수기 대회) |

### 파생 (재계산 가능 — 원본은 언제나 match_participant)
| 테이블 | 역할 |
|---|---|
| `streamer_encounter` | ★ 두 스트리머의 조우. 상대전적·맞라인의 원천 |
| `champion_stat` | 스트리머×챔피언 집계 (모스트 챔피언) |

### 커리어
| 테이블 | 역할 |
|---|---|
| `rank_snapshot` | 매일 티어 스냅샷. **오늘부터 안 쌓으면 영영 없다** |
| `season_record` | 시즌별 최고 티어. `observed` / `manual` 구분 |
| `career_event` | 대회 참가·성적. 100% 수기 |

### 운영
| 테이블 | 역할 |
|---|---|
| `ingest_cursor` | puuid별 백필 진행상황 (양방향 커서) |
| `job_run` | 크론 실행 이력 |
| `dead_match` | 404난 매치 ID (2년 경과분) — 재시도 방지 |

### 티어를 하나의 정수로 — `lp_absolute`

티어 추이 그래프의 y축이자 정렬 키. `rank_snapshot`의 생성 컬럼으로 계산한다.

```
IRON~DIAMOND : tier_idx*400 + division_idx*100 + lp      (tier_idx 0..6, division IV=0 … I=3)
MASTER 이상  : 2800 + lp                                  (M/GM/C는 LP 사다리가 연속이다)
```

---

## 4. Riot API 사용

### 라우팅 (섞으면 404가 난다)

| 라우팅 | 호스트 | 엔드포인트 |
|---|---|---|
| **regional** | `asia.api.riotgames.com` | account-v1, match-v5, tournament-v5 |
| **platform** | `kr.api.riotgames.com` | summoner-v4, league-v4, spectator-v5, champion-mastery-v4 |

### 엔드포인트별 호출 계획

| 목적 | 엔드포인트 | 주기 |
|---|---|---|
| Riot ID → puuid | `GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}` | 등록 시 1회 |
| Riot ID 최신화 | `GET /riot/account/v1/accounts/by-puuid/{puuid}` | 하루 1회 |
| 소환사 레벨/아이콘 | `GET /lol/summoner/v4/summoners/by-puuid/{puuid}` | 하루 1회 |
| **랭크** | `GET /lol/league/v4/entries/by-puuid/{puuid}` | **하루 1회 09:00 KST** |
| 매치 ID 목록 | `GET /lol/match/v5/matches/by-puuid/{puuid}/ids?startTime&endTime&queue&start&count=100` | 라이브 10분 / 백필 배치 |
| 매치 상세 | `GET /lol/match/v5/matches/{matchId}` | 신규 매치당 1회 |
| 타임라인 | `GET /lol/match/v5/matches/{matchId}/timeline` | **조우 경기만** (§5) |
| 현재 게임 | `GET /lol/spectator/v5/active-games/by-summoner/{puuid}` | 라이브 감지 |

> ~~⚠️ league-v4는 과거 `by-summoner/{summonerId}`였다. Riot이 puuid 기반으로 이전 중이므로
> **실제 키로 두 경로 다 찔러보고 동작하는 쪽을 채택**한다.~~
> **확인됨 (2026-08-09, Development 키):** `entries/by-puuid` 가 200을 낸다. puuid 로 바로 된다.
> `RiotClient.leagueEntriesByPuuid` 의 `by-summoner` 폴백은 by-puuid 가 404일 때만 타므로
> 평소엔 호출되지 않는다. 당분간 안전망으로 남겨 두고, Riot 이 by-summoner 를 걷어내면 지운다.

### RiotClient 게이트웨이 — 단일 관문 원칙

> stock-assistant의 "DuckDB 단일 writer"와 같은 발상.
> **Riot API 호출은 하나의 게이트웨이만 통과한다.** 아무 데서나 fetch 하지 않는다.

- 토큰버킷 **2중** — 앱 리밋 + 메서드별 리밋을 동시에 만족
- `429` → `Retry-After` 헤더 **존중**. 임의 백오프로 덮어쓰지 않는다
- `5xx` → 지수 백오프 재시도
- `404` (매치) → `dead_match`에 기록하고 **다시 시도하지 않는다** (2년 경과분)
- 모든 호출에 요청 ID·소요시간 로깅

---

## 5. 수집 파이프라인 — 4개의 독립 엔진

stock-assistant의 engine A/B/C 구조를 그대로 가져온다. 각 엔진은 서로를 막지 않는다.

### Engine A — 랭크 스냅샷 (매일 09:00 KST)
등록된 전 puuid → `league-v4` → `rank_snapshot` upsert.
**이게 티어 추이 그래프의 유일한 원천이다.** 하루 빠지면 그날은 영원히 구멍이다.
→ 실패 시 재시도 + 알림. 가장 중요한 크론.

### Engine B — 신규 매치 따라잡기 (10분마다)
1. `spectator-v5`로 **현재 게임 중인 puuid**를 먼저 판별
2. "직전엔 게임 중이었는데 지금은 아닌" puuid = 방금 끝난 사람 → **우선 조회**
3. `startTime = last_match_synced_at` 이후 매치 ID → 신규만 상세 조회 → 적재 → encounter 파생

> spectator를 먼저 보는 이유: 안 하는 사람을 10분마다 찌르는 낭비를 없앤다.
> 활동량 기반 적응형 폴링(활발한 계정은 5분, 휴면 계정은 6시간)도 같은 취지.

### Engine C — 과거 백필 (상시, 최저 우선순위)
`ingest_cursor` 기반으로 **오래된 쪽으로 파고든다** (`endTime` 커서를 내린다).
Engine A/B가 쓰고 남은 레이트리밋 여유분만 사용한다.
2년 경계에 닿거나 결과가 비면 `state = 'done'`.

### Engine D — 파생 재계산
- **신규 스트리머/계정 등록 시**: 그 puuid의 과거 `match_participant`를 훑어 `streamer_encounter` 재생성 ← **필수**
  → 구현됨. "쌍이 없는 경기"가 아니라 **기대 쌍 수 ≠ 실제 행 수**인 경기를 찾는다.
    이미 조우가 있는 경기에 세 번째 스트리머가 등록되는 경우까지 잡아야 하기 때문.
    반대로 매핑이 풀리면 `pruneOrphanEncounters`가 근거를 잃은 행을 지운다 (유령 전적 방지)
- `champion_stat` 재계산 — 통째로 다시 만든다. season 라벨은 `'ALL'` + **KST 연도**만.
  스플릿 경계(`2026-S2`)는 근거 있는 표가 생기기 전까지 만들지 않는다
- **조우 경기 타임라인 보강** (미구현, S3 대기): 새로 생긴 조우 경기에 한해 `/timeline` 수집
  → CS/골드 @14분 같은 진짜 라인전 지표. 전량 수집하면 수백 GB지만 조우 경기만이면 무시할 수준.
    경기당 1~5MB라 **DB에 넣을 물건이 아니다** — S3가 붙기 전에는 받아도 둘 곳이 없다

---

## 6. "재미" 지표 정의 — 제품의 심장

### 6-1. 상대전적 (H2H)
`streamer_encounter WHERE relation = 'opponent'` → A 기준 승/패.
필터: 큐 종류 / 기간 / 공개큐·내전 구분.

### 6-2. 맞라인 전적
`is_lane_matchup = true` (같은 경기 · 반대 팀 · **같은 team_position**).

라인전 우위 지표는 `challenges` jsonb에 이미 들어있다 — 타임라인 없이도 가능하다:

| 지표 | 출처 |
|---|---|
| 솔로킬 | `challenges.soloKills` |
| 10분 CS | `challenges.laneMinionsFirst10Minutes` |
| 상대 대비 최대 레벨 리드 | `challenges.maxLevelLeadLaneOpponent` |
| 킬 관여율 | `challenges.killParticipation` |
| 팀 내 딜 비중 | `challenges.teamDamagePercentage` |

**14분 골드/CS 차이**는 타임라인이 필요하다 → Engine D가 조우 경기에만 보강.

> ⚠️ **포지션은 신뢰도가 완벽하지 않다.** Riot의 `teamPosition`은 추론값이라
> 스왑 라인이나 특이 조합에서 틀린다. `individualPosition`과 불일치하면
> `is_lane_matchup = false`로 보수적으로 처리한다. 틀린 맞라인 전적은 없느니만 못하다.

### 6-3. 상성 — 표본이 작다는 걸 정직하게 다룬다

내전 몇 판짜리 승률은 그냥 노이즈다. 3승 0패를 "승률 100%"로 쓰면 거짓말이 된다.

**베이지안 축소(shrinkage)를 적용한다:**
```
상성지수 = (승수 + α·μ) / (경기수 + α)     α = 4,  μ = 0.5
```
- 3승 0패 → 생 승률 100% → **0.71** (5/7)
- 20승 5패 → 생 승률 80% → **0.76** (표본이 커질수록 생 승률에 수렴)

**그리고 표본 수를 숨기지 않는다.** `4경기 · 참고용` 뱃지를 붙인다.
> stock-assistant의 "정직 장치" 원칙과 같다. 재미 사이트라도 숫자로 거짓말하면 안 된다.

### 6-4. 파생 재미 지표

| 이름 | 정의 |
|---|---|
| **천적** | 상성지수가 가장 낮은 상대 top 3 (최소 5경기) |
| **밥** | 상성지수가 가장 높은 상대 top 3 (최소 5경기) |
| **케미** | `relation='ally'`일 때 승률이 유독 높은 짝 |
| **챔피언 상성** | A가 B를 상대로 픽했을 때 잘 되는 챔피언 |
| **악연** | 조우 횟수 자체가 가장 많은 상대 |

---

## 7. 화면 설계

```
/                      홈 — LIVE 스트리머, 오늘의 맞대결, 최근 하이라이트
/s/[slug]              ★ 스트리머 프로필           ← MVP 1순위
/vs/[slugA]/[slugB]    ★ 1:1 상대전적              ← MVP 2순위 (해자)
/streamers             전체 목록 · 검색
/ranking               리더보드 (솔랭 / 맞라인 / 상성)
/matches/[matchId]     경기 상세 — 스트리머 하이라이트
/admin/*               계정 매핑 · 후보 승인 · 커리어 수기 입력 · 제보 검수
```

### `/s/[slug]` — 프로필 구성

```
┌─────────────────────────────────────────────────────────┐
│ [프로필] 스트리머명   SOOP 링크   ● LIVE                 │
│          현재 D1 · 최고 M (2026 S1)                      │
├─────────────────────────────────────────────────────────┤
│ 계정   본계 Hide on bush#KR1  D1   [verified]           │
│        부계 두번째계정#KR2     P2   [likely]             │
├─────────────────────────────────────────────────────────┤
│ 티어 추이   ▁▂▃▅▄▆▇█        [1개월 3개월 1년 전체]      │
├─────────────────────────────────────────────────────────┤
│ 포지션 MID 62% / TOP 21%      모스트  아리 34전 62%      │
├─────────────────────────────────────────────────────────┤
│ ★ 라이벌                                                │
│   vs B스트리머   3승 1패   맞라인 2승 0패   →           │
│   vs C스트리머   1승 4패   천적                →        │
├─────────────────────────────────────────────────────────┤
│ 최근 경기                                               │
│   승  아리  8/2/11   ★ B스트리머와 맞대결               │
│   패  야스오 3/7/4                                      │
├─────────────────────────────────────────────────────────┤
│ 커리어   2026 SOOP 멸망전 준우승  [수기]                 │
└─────────────────────────────────────────────────────────┘
```

> ★ 표시가 **프로필 → 상대전적으로 넘어가는 훅**이다.
> 이게 없으면 이 사이트는 lolsoop의 열화판이다. **가장 먼저 만들어야 할 부분.**

---

## 8. 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 웹 | **Next.js 16 App Router + TypeScript** | edu-platform / hotplace-map과 동일 |
| DB | **PostgreSQL** | 집계 쿼리가 무겁다. jsonb + 생성컬럼 + 부분인덱스 필요 |
| DB 접근 | **`postgres.js` + 생 SQL** | ORM으로 표현하기 어려운 집계가 대부분 |
| 워커 | **TypeScript (Node)** | 매치 스키마 타입을 웹과 **공유**하는 이득이 크다 |
| 차트 | **인라인 SVG 직접** | 티어 추이 정도에 차트 라이브러리는 과하다 |
| 정적 데이터 | **Data Dragon 캐싱** | 런타임 외부 의존 금지 |
| 구조 | **모노레포** (`apps/web`, `apps/worker`, `packages/core`) | hotplace-map과 동일 패턴 |

```
soop-lol/
├─ apps/
│  ├─ web/           Next.js
│  └─ worker/        수집 엔진 A~D
├─ packages/
│  └─ core/          Riot 타입 · RiotClient · 지표 계산 · DB 쿼리
├─ db/
│  ├─ schema.sql
│  └─ migrations/
└─ docs/
```

> `packages/core`에 **지표 계산(상성지수·lp_absolute·맞라인 판정)을 모은다.**
> 웹과 워커가 같은 함수를 쓴다. 계산식이 두 군데 있으면 반드시 어긋난다.

### AWS 배포 — MVP는 작게

```
EC2 t4g.small 1대 (ARM, ~$12/월)
 ├─ docker compose
 │   ├─ web       Next.js standalone
 │   ├─ worker    수집 엔진
 │   └─ postgres  로컬 볼륨 (pg_dump → S3 야간 백업)
 └─ Caddy (자동 HTTPS)
S3 : 매치 원본 JSON (gzip). DB엔 정규화만 저장
Secrets Manager or .env : RIOT_API_KEY
```

트래픽이 붙으면 → RDS 분리 → 웹 ECS/Vercel 분리. **처음부터 나누지 않는다.**

> 토너먼트 콜백 제약 때문에 **도메인은 `.com` + 443**으로 잡는다 ([TOURNAMENT-CODE.md](TOURNAMENT-CODE.md) §2-1).

---

## 9. 나중에 — VOD 타임스탬프 연동 (킬러 기능 후보)

`match.game_start` + SOOP VOD의 방송 시작 시각 → **경기 시점의 다시보기 링크**를 계산할 수 있다.

```
"이 경기 다시보기 ▶"  →  https://vod.sooplive.co.kr/player/{vodId}?change_second=3782
```

상대전적 페이지에서 **"이 맞대결 영상으로 보기"**가 되면 다른 전적 사이트가 절대 못 따라온다.
SOOP Open API는 제휴 후 키 발급이라 진입 장벽이 있다 — 비공식 경로 조사 필요.

---

## 10. 로드맵

### M0 — 뼈대 ✅ 완료 (2026-08-09)
- [x] 리서치 · 설계
- [x] 모노레포 스캐폴딩, `db/schema.sql` (15테이블, PGlite 로 실행 검증)
- [x] `RiotClient` 게이트웨이 (앱+메서드 2중 레이트리밋 · `Retry-After` 존중 · 404 정상 처리)
- [x] 지표 계산 (`lp_absolute` · 맞라인 판정 · 상성지수) + 단위 테스트 32개
- [x] 관리자 화면 — 스트리머 등록 / 계정 매핑(근거 필수) / 커리어 수기 입력
- [x] 시드 스트리머 등록 — **40명 / 계정 44건**, 전부 `verified`.
      근거는 SOOP 공식 멸망전 FA 등록(본인이 입력) → [seed/README.md](../seed/README.md)

### M1 — 데이터가 흐른다 ✅ 코드 완성 (2026-08-09) / ⬜ 실데이터 미투입
- [x] Engine A (랭크 스냅샷) — 언랭도 행을 남긴다(구멍과 구분). 프로필 갱신도 같이
- [x] Engine B (신규 매치) — spectator 전이 감지 + N틱 전수 조사 안전망
- [x] Engine C (백필) — 2년 경계까지 커서를 내린다. 404 는 `dead_match`
- [x] Engine D (encounter 파생 + 재파생) — 신규 등록 시 과거 조우 복원, 매핑 철회 시 삭제
- [x] `apps/worker` 스케줄러 (A > B > D > C 우선순위 단일 루프)
- [x] `npm run verify:ingest` — 가짜 Riot(HTTP 경계만)으로 **API 키 없이** 엔진 전체 실행 검증
- [x] Riot Development 키 투입, 첫 수집 성공 — 매치 410건 · 랭크 스냅샷 44계정
- [ ] **2년 백필 완주** ← 시한부. match-v5 보존이 2년이라 미룬 만큼 영구히 사라진다.
      지금 커서는 3주 전(2026-07-20)까지만 내려갔다. Personal 키가 있어야 완주할 수 있다
- [ ] 조우 경기 타임라인 보강 — **S3 가 준비된 뒤로 미룸**. 경기당 1~5MB 라
      DB 에 넣을 물건이 아니고, 저장소 없이 만들면 넣을 곳이 없다

### M2 — MVP 화면 ✅ 코드 완성 (2026-08-09)
- [x] `/` 홈 — 최근 조우가 첫 화면이다. 이 사이트의 정의가 바로 보여야 한다
- [x] `/streamers` 목록 · 검색 (이름·별명·채널 아이디)
- [x] `/s/[slug]` 프로필 — 계정 · 티어 추이(인라인 SVG) · **라이벌 훅** · 모스트 · 최근 경기
- [x] `/vs/[a]/[b]` 상대전적 · 같은 팀 · 맞라인 (셋을 **섞지 않는다**)
- [x] 관리자: 계정 후보 검토 화면
- [ ] 데이터를 채운 뒤 UI 조정 ← **다음**. 지금은 조우 4건이라 화면 검증이 얕다

> 공개 화면은 전부 `core_public` 뷰만 읽는다. `WHERE visibility='public'` 을 질의마다
> 기억해서 지키는 게 아니라 뷰가 대신 지킨다 — 한 군데라도 빠뜨리면 그게 사고다.

### M2.5 — 데이터 채우기 · UI 조정 ← **지금 여기**
- [ ] 워커 상시 운영 (`npm run worker -- loop`)
- [ ] 조우가 쌓인 뒤 화면 조정 — 지금은 조우 4건 · **맞라인 0건**이라 `/vs` 의
      맞라인 섹션과 라이벌 정렬 기준을 검증할 수 없다
- [ ] `champion_stat` 시즌 라벨 — 지금은 `'ALL'` + KST 연도뿐.
      스플릿 경계 표가 근거 있게 확정되면 추가한다

### M3 — 배포 ⚠️ **로드맵에 빠져 있던 단계**
사이트를 띄우는 일이 어느 마일스톤에도 없었다. 그런데 이게 사슬의 한가운데다:

```
배포 → 동작하는 사이트 → Production Key 승인 → Tournament API → 내전 수집
```

Production Key 심사 요건이 **"동작하는 사이트 + 유저 플로우 설명"** 이다 (docs/SETUP.md §1-3).
배포하지 않으면 M4 의 토너먼트 코드는 시작조차 못 한다.

- [ ] 도메인 — **`.com` + 443**. 토너먼트 콜백 제약 때문이다 ([TOURNAMENT-CODE.md](TOURNAMENT-CODE.md) §2-1)
- [ ] EC2 + docker compose (web · worker · Caddy) — §8
- [ ] 워커를 상시 프로세스로 (지금은 사람이 터미널에서 띄운다)
- [ ] 매치 원본 JSON 을 S3 로 — 이게 되면 M1 의 타임라인 보강도 풀린다
- [ ] `ADMIN_PASSWORD` 교체, 백업(pg_dump → S3)

### M4 — 확장
- [x] 리더보드 — 모듈로 구현됨 (`packages/modules/leaderboard`)
- [x] 홈 하이라이트 — 최근 조우
- [ ] 제보 폼 — 계정 제보를 받아 `account_candidate` 로 넣는다 (모듈 후보)
- [ ] **토너먼트 코드 (내전)** — Production/Tournament 승인 필요. 멸망전 데이터가 여기서 열린다
- [ ] VOD 타임스탬프 — 킬러 기능 후보 (§9)
- [ ] 상성 화면 — 지금은 라이벌 목록이 판수순이다. 표본이 쌓이면 상성지수 정렬로

---

## 11. 코딩 원칙

1. **`puuid`가 유일한 키다.** Riot ID로 조인하지 않는다. 표시용 캐시일 뿐이다.
2. **계정 매핑엔 항상 근거를 남긴다.** 근거 없는 매핑은 등록하지 않는다. 부계정 노출은 실제 분쟁이 된다.
3. **표본이 작으면 작다고 말한다.** 3승 0패를 100%로 표시하지 않는다. 축소 추정 + 표본 수 표기.
4. **Riot API 호출은 게이트웨이 하나만 통과한다.** 아무 데서나 fetch 하지 않는다.
5. **파생 테이블은 언제나 재계산 가능해야 한다.** 원본은 `match_participant`. 파생은 지우고 다시 만들 수 있어야 한다.
6. **계산식은 `packages/core`가 단일 출처다.** 웹과 워커가 같은 함수를 쓴다.
7. **`404`는 정상이다.** 2년 지난 매치는 사라진다. `dead_match`에 기록하고 재시도하지 않는다.
8. **공개 큐 전적과 내전 전적을 섞지 않는다.** `source`로 항상 분리 가능해야 한다.
9. **관측 데이터와 수기 데이터를 화면에서 구분한다.** 수기는 `수기` 뱃지를 단다.
10. **타 사이트를 자동으로 긁지 않는다.** 시드는 손으로 만들고 근거를 남긴다.
