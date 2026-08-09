# 토너먼트 코드 — 내전 데이터를 잡는 유일한 합법 경로

> **왜 이 문서가 필요한가**
> 일반 커스텀 게임(=내전)은 Riot API로 **사후 조회가 불가능하다.** 프라이버시 정책이다.
> 예외가 딱 하나, **토너먼트 코드로 생성된 게임**이다.
> 즉 "앞으로의 내전을 차곡차곡 모은다"는 건 실질적으로
> **우리가 내전 주최자에게 토너먼트 코드를 발급해 주는 서비스가 된다**는 뜻이다.

MVP 단계에서는 **공개 큐만** 수집한다 (승인 불필요, 오늘 시작 가능).
이 문서는 **2단계 확장 설계**이자, 지금 DB 스키마에 `source` / `tournament_code` / `event_id`를
미리 넣어두는 이유다.

---

## 1. 토너먼트 코드란 무엇인가

롤 클라이언트의 "사용자 설정 게임"을 **미리 정해둔 설정으로 자동 생성**해 주는 **1회용 문자열**이다.

```
KR04a7-1a2b3c4-5d6e7f8-9g0h1i2-3j4k5l6
```

**참가자 입장에서의 사용법 (3단계, 매우 간단)**

1. 주최자가 준 코드를 복사
2. 롤 클라이언트 → **플레이 → 사용자 설정 → 토너먼트 코드** 입력
3. 자동으로 지정된 로비에 입장 — 맵, 픽 방식, 관전 설정, 팀 배정이 이미 다 잡혀 있다

같은 코드를 입력한 사람들끼리 **같은 방에 모인다.** 방 만들고 초대하고 설정 맞추는 과정이 통째로 사라진다.
→ 주최자에게도 실질적인 편익이 있다. **"데이터 주세요"가 아니라 "내전 세팅 편해집니다"로 팔아야 한다.**

**그리고 결정적으로** — 이 코드로 만든 게임은

- 경기가 끝나면 **Riot 서버가 우리 콜백 URL로 결과를 POST**해 주고
- 그 `gameId`로 **match-v5에서 전체 상세 데이터를 조회**할 수 있다

일반 커스텀 게임은 이 둘 다 절대 안 된다.

---

## 2. 발급 절차 (개발자 = 우리)

### 0단계 · Production Key + Tournament API 승인 ⚠️ 관문

- developer.riotgames.com에서 앱 등록 → Production Key 신청
- **요건: 동작하는 사이트/프로토타입 URL + 유저 플로우 설명**
- Tournament API 사용 사유를 별도로 기재
- 승인은 까다롭다. **실제 내전 커뮤니티가 쓰고 있다는 증거**가 가장 강력한 근거다

> **그래서 순서가 이렇게 잡힌다:**
> 공개 큐로 사이트를 먼저 띄운다 → 스트리머·시청자가 실제로 쓴다 →
> 그 트래픽과 stub으로 만들어둔 내전 UI를 증거로 Tournament API 승인 신청.

---

### 1단계 · Provider 등록 (계정당 딱 1회)

```http
POST /lol/tournament/v5/providers
Host: asia.api.riotgames.com
X-Riot-Token: <PRODUCTION_KEY>

{
  "region": "KR",
  "url": "https://soop-lol.example.com/api/riot/tournament-callback"
}
```
→ `providerId` (정수) 반환. **DB에 영구 보관.**

> ⚠️ **콜백 URL 제약이 까다롭다 — 도메인 살 때부터 고려할 것**
> - 포트는 **80(HTTP) / 443(HTTPS)만**
> - **2011년 3월 이전에 승인된 gTLD만** — `.com` `.net` `.org` 안전. 신형 TLD(`.gg` `.app` `.dev` 등)는 `[추정]` 거부 가능
> - 인증서 **CA가 2012년 1월 이전 승인분**이어야 함 — Let's Encrypt는 실무상 대체로 통과하나 `[추정]` 확인 필요
> → **`.com` 도메인 + 표준 443**으로 가는 게 안전하다.

---

### 2단계 · Tournament 생성 (내전 이벤트 1건당 1회)

```http
POST /lol/tournament/v5/tournaments
{ "providerId": 12345, "name": "목요 내전 12회차" }
```
→ `tournamentId` 반환.

> 권장: **이벤트 시작 1주일 이내에 생성.** 미리 잔뜩 만들어 두지 않는다.

---

### 3단계 · 코드 발급 (경기 1건당 코드 1개)

```http
POST /lol/tournament/v5/codes?tournamentId=67890&count=1

{
  "mapType": "SUMMONERS_RIFT",
  "pickType": "TOURNAMENT_DRAFT",
  "spectatorType": "ALL",
  "teamSize": 5,
  "enoughPlayers": true,
  "allowedParticipants": ["puuid-1", "puuid-2", "..."],
  "metadata": "our-game-row-uuid"
}
```
→ `["KR04a7-...."]` — **한 번에 최대 1,000개**

| 필드 | 값 | 설명 |
|---|---|---|
| `mapType` | `SUMMONERS_RIFT` / `HOWLING_ABYSS` / `TWISTED_TREELINE` | 내전은 소환사의 협곡 |
| `pickType` | `BLIND_PICK` / `DRAFT_MODE` / `ALL_RANDOM` / `TOURNAMENT_DRAFT` | 내전은 보통 `TOURNAMENT_DRAFT` (밴픽) |
| `spectatorType` | `NONE` / `LOBBYONLY` / `ALL` | 방송용이면 `ALL` |
| `allowedParticipants` | puuid 배열 | **선택.** 지정하면 그 사람들만 입장 가능 — 난입 방지 |
| `metadata` | 임의 문자열 | ★ **콜백에 그대로 되돌아온다.** 우리 DB의 game row id를 넣으면 매칭이 공짜 |

> ⚠️ **코드 1개 = 경기 1개.**
> 재사용하면 **콜백이 오지 않는다.** 3판 2선승제면 코드를 3개 뽑는다.
> 코드는 발급 **3개월 후 정리**된다.

---

### 4단계 · 주최자가 배포 → 참가자 입력 → 게임

우리 화면은 "코드 복사" 버튼과 진행 상태만 보여주면 된다.

---

### 5단계 · 경기 종료 → Riot이 우리 콜백을 때린다

```json
POST https://soop-lol.example.com/api/riot/tournament-callback
{
  "startTime": 1754630000000,
  "shortCode": "KR04a7-....",
  "metaData": "our-game-row-uuid",
  "gameId": 7654321,
  "gameName": "...",
  "gameType": "Practice",
  "gameMap": 11,
  "gameMode": "CLASSIC",
  "region": "KR1"
}
```

---

### 6단계 · 상세 데이터 조회

```
matchId = "KR_" + gameId          →  GET /lol/match/v5/matches/KR_7654321   (asia)
또는                                  GET /lol/match/v5/matches/by-tournament-code/{code}/ids
```

> ⚠️ **콜백만 믿지 말 것.** 재시도 보장이 약하다.
> **발급한 코드를 주기적으로 폴링하는 백업 잡**을 반드시 같이 돌린다
> (`by-tournament-code/{code}/ids`가 비어있지 않으면 수집).
> 콜백은 "빠른 경로", 폴링은 "확실한 경로".

---

## 3. 개발 단계: `tournament-stub-v5`

Production 승인 **없이도** dev key로 똑같은 흐름을 연습할 수 있다.

```
POST /lol/tournament-stub/v5/providers
POST /lol/tournament-stub/v5/tournaments
POST /lol/tournament-stub/v5/codes
```

- 반환되는 코드는 **실제 게임에선 못 쓴다** (가짜). 콜백도 오지 않는다.
- 용도: **우리 쪽 API 스키마 · DB · 화면을 전부 완성해 두고**, 승인이 나면 base path만 바꿔치기

```ts
const TOURNAMENT_BASE = process.env.RIOT_TOURNAMENT_STUB === "1"
  ? "/lol/tournament-stub/v5"
  : "/lol/tournament/v5";
```

> 이렇게 만들어 두면 **Production Key 신청의 "동작하는 프로토타입" 요건도 동시에 충족**한다.
> 즉 stub 구현은 낭비가 아니라 승인 신청서 그 자체다.

---

## 4. 지금 스키마에 미리 박아두는 것

MVP는 공개 큐만 수집하지만, 아래는 **처음부터** 넣는다.
나중에 넣으려면 이미 쌓인 데이터를 전부 마이그레이션해야 한다.

| 테이블 | 컬럼 | 이유 |
|---|---|---|
| `match` | `source` (`public_queue` / `tournament_code` / `manual`) | 공개 큐 전적과 내전 전적을 **분리해서 보여줘야** 한다. 섞으면 의미가 없다 |
| `match` | `tournament_code`, `event_id` | 어느 내전의 몇 경기인지 |
| `event` | 테이블 자체 | 내전/대회 묶음. 수기 등록 대회에도 그대로 쓴다 |
| `streamer_encounter` | `source` 비정규화 | "내전에서만 상대전적" 필터가 핵심 UX |

---

## 5. 현실 감각 — 난이도 정리

| 항목 | 난이도 | 비고 |
|---|---|---|
| stub으로 전체 흐름 구현 | 낮음 | 지금 당장 가능 |
| Production Key 승인 | **높음** | 사이트 실사용 실적이 사실상 전제 |
| Tournament API 접근 승인 | **높음** | 별도 사유 심사 |
| 내전 주최자가 우리 코드를 쓰게 만들기 | **가장 높음** | 기술 문제가 아니라 영업 문제 |

> 마지막 줄이 진짜 관문이다.
> **"내전 세팅이 편해진다"**(로비 자동 구성 + 난입 방지 + 밴픽 설정 고정)를 먼저 팔고,
> 전적 자동 집계는 덤으로 따라오게 만드는 순서여야 한다.

---

## 출처

- [Tournament V5 Is Here | Riot Games DevRel](https://www.riotgames.com/en/DevRel/tournament-v5-is-coming)
- [Riot Developer Portal — LoL Docs](https://developer.riotgames.com/docs/lol)
- [How to use a Tournament Code — Challengermode](https://support.challengermode.com/en/game-specific/how-to-use-a-tournament-code)
- [League of Legends — Riot Developer Relations](https://support-developer.riotgames.com/hc/en-us/articles/22698698001939-League-of-Legends)
