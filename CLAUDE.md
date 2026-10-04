# soop-lol — 프로젝트 지침

SOOP 스트리머들의 롤 데이터를 모아 **커리어**와 **스트리머 간 관계(상대전적·맞라인·상성)**를 보여주는 사이트.

## 한 문장 정의

> **개인 전적은 이미 여러 곳이 한다(lolsoop, sooplol, 덥덥미). 우리는 "스트리머끼리 누가 누구를 이겼나"를 한다.**

이 문장에서 벗어나는 기능은 전부 후순위다. 프로필만 예쁘게 만들면 기존 사이트의 열화판이 된다.

## 먼저 읽을 것

- **[docs/SETUP.md](docs/SETUP.md)** — 셋업·검증. 지금 뭐가 막혀 있는지도 여기 있다
- **[docs/PLAN.md](docs/PLAN.md)** — 설계 전문. 도메인 모델·수집 파이프라인·지표 정의·화면·스택·로드맵
- **[docs/RESEARCH.md](docs/RESEARCH.md)** — 경쟁 지형·데이터 소스·Riot API 제약·법적 체크리스트
- **[docs/CK-COLLECTION.md](docs/CK-COLLECTION.md)** — 내전 수집. 두 경로(토너먼트 코드·방송 VOD)의 실측 결과와 한계
- **[docs/TOURNAMENT-CODE.md](docs/TOURNAMENT-CODE.md)** — 토너먼트 코드 자체의 구조
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 식별자 분류·모듈 계약·core_public 경계
- **[db/migrations/](db/migrations/)** — 스키마의 유일한 출처. 설계 결정이 주석으로 박혀 있다

## 지금 단계

> 숫자·상태는 **2026-10-01 실DB 조회** 기준이다. 오래되면 다시 조회하고 고친다 — 이 절을 근거로 "없는 기능"이라 판단하지 않는다.

수집 경로마다 상태가 다르다.

| 경로 | 상태 | 문서 |
|---|---|---|
| **롤 내전 — 방송 VOD 판독** | **운영 중.** VOD 판독 경기 87건(`origin='vod_scan'`). 매일 자동 조사(`scripts/ck-auto.sh`)·사용자 요청 백필 | [docs/CK-COLLECTION.md](docs/CK-COLLECTION.md) · [docs/CK-BACKFILL.md](docs/CK-BACKFILL.md) |
| 롤 대회 — 나무위키 시드 | 경기 875건(`origin='wiki_seed'`, 멸망전 등 과거 대회). 롤 수기 경기 전체가 만든 조우 34,399건 | [seed/README.md](seed/README.md) |
| **FC 온라인 — 넥슨 API + VOD 맥락** | **운영 중.** API 경기 2,790건. 화면으로만 아는 경기(30일 이전)는 저장 구조만 있다(0050, 공개 전) | [docs/FCO-SCREEN-MATCH-DESIGN.md](docs/FCO-SCREEN-MATCH-DESIGN.md) |
| FC 온라인 — 구단가치·스쿼드·시세(공식 홈페이지) | 2026-10-02 첫 수집(16계정, 카드 379장). 주기 실행은 서버 배포 때(구단 2시간 · 시세 하루 1회). 그 전엔 손으로 `worker -- fco-club` | [docs/FCO-CLUB-VALUE-PLAN.md](docs/FCO-CLUB-VALUE-PLAN.md) |
| **롤 공개 큐 — Riot API(워커 Engine A~D)** | 코드 완성, **지금 데이터 없음**(공개 큐 경기 0건). Riot 키 상태는 docs/SETUP.md §1 에서 확인한다 | [docs/PLAN.md](docs/PLAN.md) §10 |
| 롤 내전 — 토너먼트 코드 | 미시작. Production Key 가 필요하고 그 심사 요건이 "동작하는 사이트"라 **배포(M4) 뒤에만** 가능하다. VOD 판독과는 별개 경로다 | [docs/TOURNAMENT-CODE.md](docs/TOURNAMENT-CODE.md) |

시한부인 것 두 개 (Riot 수집을 돌릴 때):
- **2년 백필** — match-v5 보존이 2년이다. 미룬 만큼 영구히 사라진다
- **랭크 스냅샷** — 하루 안 쌓으면 그날은 영원히 구멍이다. `worker -- rank` 만 돌려도 된다

FC 도 시한부다 — 넥슨 목록은 **최근 30일**만 준다(docs/FCO-TIME-SAMPLES.md).
FC 구단가치·스쿼드 스냅샷도 시한부다 — 지나간 날은 다시 못 구한다(`worker -- fco-club`). 카드 시세는 365일까지 소급된다.

## 검증 명령

```bash
npm test              # 핵심 로직 단위 테스트
npm run verify:db     # 스키마·제약·질의를 실제 Postgres(PGlite)에 올려 실행 검증
npm run verify:ingest # 수집 엔진 A~D 를 가짜 Riot 으로 끝까지 실행 (API 키 불필요)
npm run verify:modules # 모듈 경계 검사 — 규칙을 문서가 아니라 검사로 강제한다
```

`verify:*` 는 장식이 아니다 — `lp_absolute` 가 SQL 과 TS 에서 같은 값을 내는지,
근거 없는 매핑이 실제로 거부되는지, 백필 커서가 정말 내려가는지,
**신규 스트리머 등록 후 과거 조우가 되살아나는지**를 전부 **돌려서** 확인한다.
스키마·지표·수집을 건드렸으면 이걸 통과시키고 커밋한다.

`verify:ingest` 에서 가짜인 것은 **HTTP 경계 하나뿐**이다(`scripts/fake-riot.ts`).
`RiotClient` 를 모킹하지 않는 이유는, 라우팅·레이트리밋·404 처리가
정작 틀리기 쉬운 곳인데 모킹하면 그게 통째로 검증에서 빠지기 때문이다.

## 워커

```bash
npm run worker -- loop     # 운영 기본값. A > B > D > C 우선순위 단일 루프
npm run worker -- rank | live | backfill | derive
```

레이트리밋 버킷이 `RiotClient` 안에 있으므로 **프로세스당 클라이언트는 하나**다.
엔진마다 새로 만들면 각자 "나는 안 넘었다"고 믿으면서 합쳐서 리밋을 넘긴다.

## 반드시 기억할 제약 3가지

1. **커스텀 게임(내전)은 Riot API로 사후 조회가 불가능하다.** 토너먼트 코드로 만든 게임만 잡힌다.
   → MVP는 **공개 큐만** 수집한다. 내전은 2단계.
2. **match-v5 보존은 2년이고 실제론 더 짧을 수 있다.** 백필은 시한부다. 명단이 정해지면 즉시 긁는다.
3. **과거 시즌 티어는 API에 없다.** `rank_snapshot`을 오늘부터 안 쌓으면 그날은 영원히 구멍이다.

## 코딩 원칙

1. **`puuid`가 유일한 키다.** Riot ID(`닉네임#태그`)는 바뀐다. 조인에 쓰지 않는다. 표시용 캐시일 뿐.
2. **계정 매핑엔 항상 근거를 남긴다.** `streamer_account.evidence` 없이 행을 만들지 않는다.
   부계정 오노출은 실제 분쟁이 된다. `confidence`를 화면에 노출하고, 삭제 요청 경로(`visibility`)를 항상 살려둔다.
3. **표본이 작으면 작다고 말한다.** 3승 0패를 "승률 100%"로 쓰지 않는다.
   베이지안 축소(α=4, μ=0.5) + 표본 수 표기. 재미 사이트라도 숫자로 거짓말하면 안 된다.
4. **Riot API 호출은 게이트웨이 하나만 통과한다.** 아무 데서나 fetch 하지 않는다.
   토큰버킷(앱+메서드 2중), `429`는 `Retry-After` 존중, `404`는 정상 케이스.
5. **파생 테이블은 언제나 재계산 가능해야 한다.** 원본은 `match_participant`.
   `streamer_encounter`·`champion_stat`은 지우고 다시 만들 수 있어야 한다.
   ⚠️ **신규 스트리머 등록 시 과거 매치를 훑어 encounter를 재파생**하는 잡을 빼먹지 말 것.
6. **계산식은 `packages/core`가 단일 출처다.** 웹과 워커가 같은 함수를 쓴다.
   상성지수·`lp_absolute`·맞라인 판정을 양쪽에 따로 구현하면 반드시 어긋난다.
7. **공개 큐 전적과 내전 전적을 섞지 않는다.** `match.source`로 항상 분리 가능해야 한다.
8. **관측 데이터와 수기 데이터를 화면에서 구분한다.** 수기는 `수기` 뱃지를 단다.
9. **타 사이트를 자동으로 긁지 않는다.** op.gg·lolsoop·덥덥미 스크래핑 금지 —
   ToS 위반이고 Riot Production Key 심사에서도 감점이다. 시드는 손으로 만들고 근거를 남긴다.
10. **포지션 추론값을 맹신하지 않는다.** `teamPosition`과 `individualPosition`이 불일치하면
    맞라인 판정에서 제외한다. 틀린 맞라인 전적은 없느니만 못하다.
