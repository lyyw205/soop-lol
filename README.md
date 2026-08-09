# soop-lol

SOOP 스트리머들의 롤 데이터를 모아 **커리어**와 **스트리머 간 관계(상대전적·맞라인·상성)**를 보여주는 사이트.

> **개인 전적은 이미 여러 곳이 한다. 우리는 "스트리머끼리 누가 누구를 이겼나"를 한다.**

## 빠른 시작

```bash
npm install
npm run dev:db     # 터미널 1 — 임시 Postgres(PGlite) + 샘플 데이터
npm run dev        # 터미널 2
```

`apps/web/.env.local` 은 [docs/SETUP.md §4](docs/SETUP.md) 참고. → http://localhost:3000/admin

## 문서

| 문서 | 내용 |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | **여기부터.** Riot API 키 발급, Supabase, 로컬 개발, 검증 |
| [docs/PLAN.md](docs/PLAN.md) | 설계 전문 — 도메인 모델·수집 파이프라인·지표 정의·화면·로드맵 |
| [docs/RESEARCH.md](docs/RESEARCH.md) | 경쟁 지형·데이터 소스·Riot API 제약·법적 체크리스트 |
| [docs/TOURNAMENT-CODE.md](docs/TOURNAMENT-CODE.md) | 내전 데이터를 잡는 유일한 경로 (2단계) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **식별자 분류 · 모듈 계약 5조 · core_public 경계** |
| [CLAUDE.md](CLAUDE.md) | 코딩 원칙 |

## 구조

```
apps/web/            Next.js 16 (App Router). 공개 화면 + 관리자 + /m/[module] 마운트
apps/worker/         수집 엔진 A~D + 모듈 잡 스케줄러
packages/core/       Riot 클라이언트·지표 계산·DB 질의·수집 변환
  lib/contract/      ★ 모듈에 노출하는 전부 (core_public 뷰만 읽는다)
packages/modules/    기능 모듈. 지워도 core 와 다른 모듈에 영향이 없다
db/migrations/       스키마의 유일한 출처
scripts/             dev-db · verify-db · verify-ingest · verify-modules · sync-modules
docs/
```

## 명령

```bash
npm run dev            # 웹 개발 서버
npm run dev:db         # 로컬 임시 Postgres (메모리)
npm run worker -- loop # 수집 워커 (rank | live | backfill | derive 도 가능)
npm test               # 핵심 로직 단위 테스트
npm run verify:db      # 스키마·제약·질의를 실제 Postgres 에서 실행 검증
npm run verify:ingest  # 수집 엔진 A~D 를 가짜 Riot 으로 끝까지 실행 (API 키 불필요)
npm run verify:modules # 모듈 경계 검사 (import 그래프 + SQL)
npm run typecheck
npm run build
```

## 진행 상황

- [x] 리서치 · 설계 · 스키마
- [x] `RiotClient` 게이트웨이 (2중 레이트리밋 · `Retry-After` 존중 · 404 정상 처리)
- [x] 지표 계산 (맞라인 판정 · 상성지수 · 티어 환산)
- [x] 관리자 화면 — 스트리머 등록, 계정 매핑(근거 필수), 커리어 수기 입력
- [x] 수집 워커 (Engine A~D) — 랭크 스냅샷 · 신규 매치 · 2년 백필 · 조우 재파생
- [ ] Riot API 키 투입 후 실제 수집 ← **다음** (docs/SETUP.md §1)
- [ ] 공개 화면 `/s/[slug]`, `/vs/[a]/[b]`
- [ ] 토너먼트 코드 (내전)

---

이 사이트는 Riot Games 와 무관하며, Riot Games 가 공식적으로 보증하지 않습니다.
