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
npm run seed:tournament -- seed/tournaments.json --dry-run
npm run seed:tournament -- seed/tournaments.json
```

멸망전은 내전(커스텀 게임)이라 Riot API 로 조회할 수 없다. 주최측이 공개한 것이 유일한 원천이다.

### 어디서 얻나 (2026-08-10 직접 확인)

| 데이터 | 경로 | 상태 |
|---|---|---|
| 역대 회차 목록 | Wayback 의 `static.file.afreecatv.com/bjmatch/gnb.js` | ✅ **LoL 24회차(2014~2023)** 운영 DB 덤프 |
| 2024~2026 회차 | 공식 VOD API 제목 라벨 | ✅ 6회차 추가 |
| 대진(누가 누구와) | 공식 VOD 제목 — `[A vs B] UB 2R 7경기` | ✅ 회차별로 복원 가능 |
| **승패** | VOD 제목에 없음 | ⚠️ **더블 엘리미네이션 진출 경로로 유도** |
| 로스터 | FA API(현재 대회만) · 나무위키 | ⚠️ 과거 회차는 사실상 없음 |

```bash
# 공식 VOD 전량 (2,392건, 2018-04 ~ )
curl -s 'https://chapi.sooplive.com/api/lolbjmatch/vods/all?page=1&per_page=60&orderby=reg_date'   -H 'Referer: https://ch.sooplive.co.kr/lolbjmatch'
```

### 승패를 어떻게 아는가

VOD 제목은 대진만 주고 승패를 안 준다. 대신 **더블 엘리미네이션은 진출 경로가 곧 결과**다 —
UB 1R 의 승자만 UB 2R 에 나타나고 패자는 LB 1R 로 떨어진다. 14경기 대진이 이 규칙과
모순 없이 맞물리고, 결승 승자는 뉴스로 독립 확인된다.

`scripts/build-meljang-2026.mjs` 가 이 유도를 하면서 **정합성을 검사한다** —
이미 2패한 팀이 다시 나오거나 승자가 대진에 없으면 거기서 멈춘다.
이건 추측이 아니라 유도이고, 검사를 통과해야만 시드가 만들어진다.

### ❌ 통하지 않은 경로

| 경로 | 결과 |
|---|---|
| Leaguepedia / Liquipedia | 멸망전을 **아예 다루지 않는다**. Cargo API 로 SOOP 관련은 SLL 2건뿐 |
| SOOP FA API 과거 시즌 | `seasonIdx` 1~60 중 **27번만** 존재 — 아카이브가 아니다 |
| 공식 마이크로사이트 | `bjmatch.afreecatv.com` 은 죽었고, Wayback 캡처도 XHR 로 채우는 빈 템플릿 |
| 2014·2015·2017 회차 | 회차가 있었다는 사실 외 **아무 자료도 없다** (VOD 아카이브가 2018-04 부터) |

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

## `seed/streamers.json` 은 커밋하지 않는다

저장소가 공개라서다. 스트리머의 부계정 목록이 git 히스토리에 들어가면
나중에 삭제 요청이 와도 **되돌릴 수 없다.** 히스토리는 지워지지 않는다.

근거는 DB 의 `streamer_account.evidence` 에 남고, 그쪽은 `visibility` 로 숨기거나
행을 지울 수 있다. 그게 삭제 요청 경로를 살려두는 유일한 방법이다.

파일 자체는 로컬이나 비공개 백업에 보관한다.
