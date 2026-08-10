# 시드 명단

```bash
cp seed/streamers.example.json seed/streamers.json   # 손으로 채운다
npm run seed -- seed/streamers.json --dry-run        # 무엇이 바뀔지만 본다
npm run seed -- seed/streamers.json                  # 실제로 넣는다
```

같은 파일을 다시 돌려도 안전하다. `slug` 가 이미 있으면 갱신한다.

## 명단·계정을 어디서 얻나 (2026-08-09 확인)

### ★ SOOP 멸망전 FA 등록 — 계정 매핑의 정답 경로

스트리머가 **대회 참가 신청 때 본인 손으로 입력한 라이엇 ID** 다. SOOP 공식 데이터이고,
제출 시점에 SOOP 이 Riot 으로 실존 검증까지 한다. 전적 사이트도 위키도 아니다 —
`evidence.source = 'self_declared'` 로 쓰기에 충분한 유일한 경로였다.

```bash
curl -s -X POST https://gpapi.sooplive.com/api/v1/bjmatchfa/fa/list \
  -H 'Content-Type: application/json' \
  -d '{"orderType":"point_desc","filter":[],"searchBjNick":"","minPoint":0,"maxPoint":1000,
       "positionIdx":"","pageNo":1,"perPageNo":500,"seasonIdx":27}'
```

- `seasonIdx` 가 대회 회차다 (27 = 2026 LoL 멸망전 with Gen.G). 사람이 보는 페이지는
  `https://bjmatchfa.sooplive.com/fa/27` — 이게 `evidence.url` 이 된다
- 응답의 `gameNick` / `totalGameNickList` 가 라이엇 ID. 부계정까지 들어 있다
- `userId` 가 SOOP 채널 아이디, `userNick` 이 표시명
- **2026-08-09 기준 418명**이 등록돼 있다. 명단 확장의 1차 소스다

### SOOP 닉네임 → 채널 아이디

```
https://sch.sooplive.co.kr/api.php?m=bjSearch&v=3.0&szKeyword=<닉네임>
https://chapi.sooplive.co.kr/api/<id>/station     # 교차 확인용
```

### ⚠️ 반드시 Riot API 로 되짚어라

SOOP 표기가 라이엇 정본과 어긋난다. 실제로 겪은 것:
- 태그에 공백이 들어간 채 저장돼 있다 — `#산 본`, `#팀 운`
- 게임명 공백 수가 다르다 — SOOP `TT TT` ↔ 라이엇 `TT  TT`(두 칸)
- 48건 중 4건은 아예 해석되지 않았다 (계정 삭제·개명 추정)

그래서 `scripts/seed-streamers.ts` 는 `riot_id` 를 받아 **account-v1 으로 해석한 결과**를
정본으로 쓴다. 해석 실패한 건 넣지 않는다.

### ❌ 통하지 않은 경로 (다시 시도하지 말 것)

| 경로 | 결과 |
|---|---|
| 대회 로스터 이름을 라이엇 ID 로 간주 | **위험.** `스맵임`은 lv1 언랭 남의 계정, `뀨삐`는 공백 정규화로 `뀨 삐`가 잡힌다 |
| 뉴스·나무위키 | 인게임 ID 를 안 싣거나, 실어도 태그가 없다 |
| SOOP 채널 공지 게시판 | 스트리머 본인이 라이엇 ID 를 적어두지 않는다 (40명 표본에서 0건) |
| 전적 사이트 | 지침상 금지 (§11-9). ToS 위반이고 Production Key 심사 감점 |

## 대회 기록 (seed/tournaments.json)

```bash
# 회차 데이터(대진·로스터)는 scripts/meljang-seasons.mjs 에 있다. 승패는 적지 않는다 —
# 빌더가 진출 경로로 유도하고 모순이 있으면 멈춘다.
node --env-file-if-exists=apps/web/.env.local scripts/build-meljang.mjs meljang-2025-s2
npm run seed -- seed/streamers-meljang-2025-s2.json          # 새로 등장한 참가자
npm run seed:tournament -- seed/tournaments-meljang-2025-s2.json
```

멸망전은 내전(커스텀 게임)이라 Riot API 로 조회할 수 없다. 주최측이 공개한 것이 유일한 원천이다.

### 어디서 얻나 (2026-08-10 직접 확인)

| 데이터 | 경로 | 상태 |
|---|---|---|
| 역대 회차 목록 | `static.file.sooplive.co.kr/bjmatch/gnb.js` (지금도 살아 있다) | ✅ **LoL 24회차(2014~2023)** 운영 DB 덤프 |
| 2024~2026 회차 | 공식 VOD API 제목 라벨 | ✅ 6회차 추가 |
| 대진(누가 누구와) | 공식 VOD 제목 — `[A vs B] UB 2R 7경기` | ✅ **33회차 중 28회차** 복원 가능 (2018 시즌2~) |
| **승패** | VOD 제목에 없음 | ⚠️ **진출 경로로 유도** (아래) |
| 로스터 | 나무위키 | ⚠️ 회차별로 있고 없고 갈린다 |
| 로스터 → 라이엇 계정 | SOOP 검색 API → FA 등록 | ✅ 방송국 아이디로 교차 (아래) |

```bash
# 공식 VOD 전량 (2,392건, 2018-04 ~ )
curl -s 'https://chapi.sooplive.com/api/lolbjmatch/vods/all?page=1&per_page=60&orderby=reg_date'   -H 'Referer: https://ch.sooplive.co.kr/lolbjmatch'
```

### 승패를 어떻게 아는가

VOD 제목은 대진만 주고 승패를 안 준다. 대신 **진출 경로가 곧 결과**다.
이건 추측이 아니라 유도이고, 생성 스크립트가 **모순을 검사한 뒤에만** 시드를 만든다.

**더블 엘리미네이션** (`scripts/build-meljang-2026.mjs` — 2026 with Gen.G):
UB 1R 의 승자만 UB 2R 에 나타나고 패자는 LB 1R 로 떨어진다.
이미 2패한 팀이 다시 나오거나 승자가 대진에 없으면 거기서 멈춘다.

**GSL 조별 + 4강 + 결승** (`scripts/build-meljang-2026-s1.mjs` — 2026 시즌1):
```
승자전 = 1경기 승자 vs 2경기 승자        → 1·2경기 승자가 정해진다
패자전 = 1경기 패자 vs 2경기 패자        → 위와 어긋나면 대진 복원이 틀린 것 (검사)
최종전 = 승자전 패자 vs 패자전 승자      → 승자전·패자전 승자가 정해진다
4강 진출 = 승자전 승자(조1위) + 최종전 승자(조2위)
4강 대진 = A조1위 vs B조2위 / B조1위 vs A조2위 (크로스) → 조 순위 교차검증
결승 대진 = 4강 두 경기의 승자
```
13경기 중 **12경기가 유도**되고, 남는 결승 승자 하나만 언론으로 독립 확인한다.

### 로스터 닉네임 → 라이엇 계정 (근거 있는 유일한 경로)

나무위키 로스터의 닉네임을 **라이엇 ID 로 간주하면 안 된다**(아래 ❌ 표 참고).
대신 두 단계로 되짚는다:

1. SOOP 검색 API 로 닉네임 → **방송국 아이디**. 정확히 일치하는 게 하나일 때만 채택한다
   ```
   https://sch.sooplive.co.kr/api.php?m=bjSearch&v=3.0&szKeyword=<닉네임>&nPageNo=1&nListCnt=10
   ```
2. 그 방송국 아이디로 **FA 등록**(본인이 직접 입력한 라이엇 ID)을 찾는다. 없으면 넣지 않는다.

2026 시즌1 로스터 40명 중 **39명이 이렇게 해결**됐다 (10명은 이미 등록돼 있었고 29명이 신규).
남은 1명(`R0se`)은 닉네임이 바뀌어 방송국 아이디를 특정하지 못해 **뺐다**.

이 단계가 왜 필요한지는 실제로 걸린 예가 말해준다 —
`레이닝1`은 `김레인♥`이 아니고, `해기_`는 `하쿠^^`가 아니다. 닉네임만 봤으면 둘 다 틀렸다.

### ❌ 통하지 않은 경로

| 경로 | 결과 |
|---|---|
| Leaguepedia / Liquipedia | 멸망전을 **아예 다루지 않는다**. Cargo API 로 SOOP 관련은 SLL 2건뿐 |
| SOOP FA API 과거 시즌 | `seasonIdx` 1~60 중 **27번만** 존재 — 아카이브가 아니다 |
| 공식 마이크로사이트 | `bjmatch.afreecatv.com` 은 **다른 페이지(2017 BJ대상)로 대체**됐다. 앱이 사라졌다 |
| 마이크로사이트 Wayback | 도메인 전체 캡처가 100건뿐이고 LoL 의 `page=TEAM`·`page=TOURNAMENT` 는 **0건**. 잡힌 것도 XHR 로 채우는 빈 껍데기(7KB) |
| 2014·2015·2017 회차 | 회차가 있었다는 사실 외 **아무 자료도 없다** (VOD 아카이브가 2018-04 부터) |
| 2021 시즌2·앙코르전, 2023 한일 | VOD 제목에 `vs` 가 아예 없다 — 대진 복원 불가 |

## 규칙

1. **손으로 만든다.** op.gg·lolsoop·덥덥미를 긁어오지 않는다 —
   ToS 위반이고 Riot Production Key 심사에서도 감점이다 (docs/PLAN.md §11-9).
2. **근거 없는 계정은 적지 않는다.** `evidence.url` 이나 `evidence.note` 가 비면
   스크립트가 거부한다. 부계정 오노출은 실제 분쟁이 된다 (§11-2).
3. `confidence` 는 정직하게 매긴다.
   - `verified` — 본인이 공개적으로 밝혔고 그 출처가 남아 있다
   - `likely` — 정황은 강하지만 본인 확인은 없다
   - `unverified` — 제보만 있다
   이 값은 화면에 그대로 노출된다. 애매한 걸 `verified` 로 올리지 않는다.

## 적재된 회차

| 회차 | 경기 | 조우 | 결승 승자 근거 |
|---|---|---|---|
| 2025 LoL 멸망전 시즌1 | 13 | 453 | ⚠ 나무위키 역대 표 **한 곳뿐** |
| 2025 LoL 멸망전 시즌2 | 13 | 473 | 나무위키 역대 표 + 공식 VOD 결승 인터뷰 클립 |
| 2026 LoL 멸망전 시즌1 | 13 | 549 | 인벤 등 언론 |
| 2026 LoL 멸망전 with Gen.G | 14 | 576 | 언론 |

결승을 뺀 나머지 경기는 전부 **진출 경로로 유도**된 것이고 근거가 코드에 있다.

### 결승 승자는 반드시 두 곳에서 확인한다

나무위키의 회차별 문서와 역대 우승 표가 **실제로 어긋난 적이 있다** —
2025 시즌2 문서를 요약하면 "jJ이야 우승"으로 읽히는데, 역대 표와 검색 결과와
결승 당일 공식 VOD 클립(`[클립]깐숙 인터뷰 결승`, 깐숙은 킹깐만 소속)은 전부 킹깐만이다.
세트 스코어의 좌우가 뒤집혀 읽히기 쉽다. 한 곳만 보고 적으면 우승팀을 반대로 쓴다.

교차 확인이 잘 되는 곳:
- 공식 VOD 제목 — `[클립]멸망전 2모3촌 최종우승 !`, `으딜나대나 팀 우승 트로피 세레머니`
- 결승 당일·다음날 언론 기사
- 공식 방송국 게시판(`board`) 의 결승 직후 글

### 로스터에 사람이 빠져 있어도 넣는다

계정 근거를 못 찾은 사람은 그 자리를 비운 채 경기를 넣는다.
나중에 계정이 연결되면 `seed:tournament` 를 다시 돌려 **그 사람의 조우가 되살아난다**
(§11-5 재파생). 근거 없이 채워 넣는 것보다 비워 두는 게 낫다.

## `seed/streamers*.json` 은 커밋하지 않는다

저장소가 공개라서다. 스트리머의 부계정 목록이 git 히스토리에 들어가면
나중에 삭제 요청이 와도 **되돌릴 수 없다.** 히스토리는 지워지지 않는다.

근거는 DB 의 `streamer_account.evidence` 에 남고, 그쪽은 `visibility` 로 숨기거나
행을 지울 수 있다. 그게 삭제 요청 경로를 살려두는 유일한 방법이다.

파일 자체는 로컬이나 비공개 백업에 보관한다.
