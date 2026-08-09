# 셋업

## 0. 지금 상태 (2026-08-09)

| 항목 | 상태 |
|---|---|
| 모노레포·스키마·관리자 화면 | ✅ 완성, 검증됨 |
| 수집 워커 (Engine A~D) | ✅ 완성, 검증됨 → §6 |
| Supabase 프로젝트 | ✅ 생성·스키마 적용·RLS → §2 |
| Supabase DB 비밀번호 | ❌ 대시보드에서 받아 `.env.local` 에 넣어야 함 → §2 |
| Riot API 키 | ❌ 없음 → §1 |
| 실제 데이터 수집 | ⬜ 위 둘이 채워지면 시작 |

**API 키 없이도 관리자 화면은 지금 돌려볼 수 있다** (§3).
**워커도 API 키 없이 검증할 수 있다** — `npm run verify:ingest` (§5).

---

## 1. Riot API 키

### 1-1. Development 키 — 지금 바로, 개발용

1. [developer.riotgames.com](https://developer.riotgames.com) 에 Riot 계정으로 로그인
2. 대시보드에 **DEVELOPMENT API KEY** 가 바로 보인다. `REGENERATE API KEY` 로 발급
3. `apps/web/.env.local` 의 `RIOT_API_KEY=` 에 붙여넣기

> ⚠️ **24시간마다 죽는다.** 매일 재발급해서 갈아끼워야 한다.
> 리밋도 20 req/s · 100 req/2min 으로 빡빡하다 — 백필이 33시간쯤 걸린다.
> 개발·시험용이고, 이걸로 공개 운영하면 안 된다.

### 1-2. Personal 키 — 운영의 최소선. **오늘 신청해 둘 것**

1. 포털 상단 **REGISTER PRODUCT** → **Personal API Key** (개인 프로젝트 쪽)
2. 폼에 제품 정보를 적는다. 실제로 적을 내용:
   - **무엇**: SOOP 스트리머들의 롤 전적을 모아 스트리머 간 상대전적·맞라인 전적을 보여주는 팬 사이트
   - **누가 쓰나**: 해당 스트리머의 시청자
   - **어떤 데이터**: match-v5, league-v4, summoner-v4, account-v1, spectator-v5
   - **수익화**: 없음 (있으면 정직하게 적는다)
3. Dev Relations 팀 검토 → 승인까지 **수일~수주**. 3주 넘게 걸린 사례도 보고돼 있다

> Personal 키는 **표준 API 만** 준다. **Tournament API 는 포함되지 않는다.**
> 만료가 없어서 워커를 상시로 돌릴 수 있는 게 핵심 이득이다.

### 1-3. Production 키 — 나중에

- 요건이 **"동작하는 사이트 + 유저 플로우 설명"** 이다. 사이트가 실제로 돌기 전엔 승인되지 않는다.
- Tournament API(내전 수집)는 여기 붙는다 → [TOURNAMENT-CODE.md](TOURNAMENT-CODE.md)
- 순서: 공개 큐로 사이트 띄우기 → 실사용 붙기 → 그걸 근거로 Production + Tournament 신청

---

## 2. Supabase — ✅ 준비됨

| 항목 | 값 |
|---|---|
| 프로젝트 | `soop-lol` |
| ref | `eiwmgkdktgdgphlugieu` |
| 리전 | `ap-northeast-2` (서울) |
| 스키마 | 적용 완료 — 테이블 15개 · `lol_lp_absolute` · **RLS 전체 ON** |

무료 플랜은 **조직당 활성 프로젝트 2개**까지라 `edu-platform` 을 **일시정지**해서 자리를 냈다
(2026-08-04 시드 데이터만 있고 5일간 활동 없음 — auth 사용자 0, 신청 0, 문의 0).
되살리려면 대시보드에서 Restore 하면 되고, 그러면 이번엔 이쪽이 자리를 비켜줘야 한다.

### 접속 경로 — **풀러를 쓴다** (직결은 WSL 에서 안 붙는다)

직결 `db.<ref>.supabase.co:5432` 는 **IPv6 전용**이다. WSL 에서는 `ENETUNREACH` 가 난다.
그래서 `.env.local` 의 기본값을 트랜잭션 풀러로 잡아 뒀다:

```
postgresql://postgres.eiwmgkdktgdgphlugieu:<PASSWORD>@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres
```

- 사용자명이 `postgres` 가 아니라 **`postgres.<ref>`** 다. 풀러는 이걸로 테넌트를 가른다
- `aws-N` 의 숫자는 프로젝트마다 다르다. 이 프로젝트는 **`aws-0`** 임을 실제로 찔러서 확인했다
  (`aws-0` → `28P01` = 테넌트를 찾고 비밀번호만 거부, `aws-1` → `XX000` = 테넌트 없음)
- `prepare` 는 [`client.ts`](../packages/core/lib/db/client.ts) 에서 이미 꺼 뒀으므로 트랜잭션 풀러로 안전하다

### 남은 한 걸음 — DB 비밀번호

비밀번호는 API 로 가져올 수 없다. 대시보드에서 직접 받아야 한다:

1. **Project Settings → Database → Database password → Reset database password**
2. 나온 값을 `apps/web/.env.local` 의 `DATABASE_URL` 안 비밀번호 자리에 넣는다
3. 확인: `npm run dev` → http://localhost:3000/admin 이 뜨면 붙은 것

> 인증이 틀리면 `28P01` 이 뜬다. 호스트가 틀리면 `XX000` 이다 — 둘을 헷갈리지 말 것.
> `28P01` 은 "거기까진 갔는데 비밀번호가 틀렸다"는 뜻이므로 리셋하면 풀린다.

### RLS 를 켜 둔 이유

Supabase 는 `public` 스키마를 PostgREST 로 자동 노출한다. 정책 없이 RLS 만 켜 두면
anon 키로는 아무것도 못 읽고, 우리 앱(`postgres.js` 로 소유자 롤 직결)은 영향을 받지 않는다.

이건 형식적인 조치가 아니다 — 안 켜면 `streamer_account.visibility = 'hidden'` 인 부계정과
`evidence`(제보자 메모)가 anon 키만으로 그대로 읽힌다. 삭제 요청 경로를 살려둔 의미가 사라진다.
공개 API 가 필요해지면 그때 **뷰 + 명시적 정책**으로 연다.

> 스키마를 바꿀 땐 [`db/schema.sql`](../db/schema.sql) 을 고치고 Supabase 에도 같이 적용한다.
> 로컬 검증(`npm run verify:db`)이 보는 건 그 파일이므로, 둘이 어긋나면 검증이 거짓말을 하게 된다.

---

## 3. 로컬 개발 — Supabase 없이도 된다

PGlite(WASM Postgres)를 진짜 포트에 물려 주는 개발용 DB가 들어 있다.

```bash
npm install

# 터미널 1 — 임시 Postgres (메모리. 끄면 사라진다). 샘플 데이터도 들어간다.
npm run dev:db

# 터미널 2
cp apps/web/.env.example apps/web/.env.local   # 아래 §4 대로 채운다
npm run dev
```

→ http://localhost:3000/admin (Basic 인증: `ADMIN_USER` / `ADMIN_PASSWORD`)

> ⚠️ 이때 `DATABASE_POOL_MAX=1` 이 **필수**다. PGlite 소켓 서버는 동시 연결을 못 받아서
> 커넥션이 2개가 되는 순간 `read ECONNRESET` 이 난다. 실제 Postgres 에서는 필요 없다.

---

## 4. 환경변수 (`apps/web/.env.local`)

```bash
# 로컬 PGlite 를 쓸 때
DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres
DATABASE_POOL_MAX=1

# Supabase 를 쓸 때 (DATABASE_POOL_MAX 는 빼도 된다)
# DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres

RIOT_API_KEY=RGAPI-...        # 없으면 관리자 화면이 puuid 직접 입력 모드로 떨어진다

ADMIN_USER=admin
ADMIN_PASSWORD=바꿀것          # ★ 비면 /admin 이 503 으로 잠긴다 (fail-closed)
```

---

## 5. 검증

```bash
npm test              # 핵심 로직 단위 테스트 57개
npm run verify:db     # 스키마를 실제 Postgres 에 적용하고 제약·질의를 전부 실행
npm run verify:ingest # 수집 엔진 A~D 를 가짜 Riot 으로 끝까지 돌린다 (API 키 불필요)
npm run typecheck
npm run build
```

`verify:db` 가 확인하는 것:
- `db/schema.sql` 이 오류 없이 적용되는가 (테이블 15개)
- `lp_absolute` 가 SQL 과 TS 에서 **같은 값**을 내는가 (93개 조합)
- 근거 없는 계정 매핑을 실제로 **거부**하는가
- 한 계정을 두 스트리머가 동시에 못 갖는가
- `streamer_encounter` 의 역순 쌍을 CHECK 가 막는가
- 관리자 질의(`adminCounts`, `listStreamers`, …)가 진짜로 도는가

`verify:ingest` 가 확인하는 것 — **돌려보지 않으면 알 수 없는 것들이다**:
- 언랭 계정도 `rank_snapshot` 에 자리가 남는가 (잡이 안 돈 것과 구분되는가)
- 게임 중인 계정에 match-v5 를 낭비하지 않는가
- 백필 커서가 **반드시 내려가는가** (제자리걸음이면 영원한 루프다)
- 404 매치를 `dead_match` 에 넣고 다시 부르지 않는가
- **신규 스트리머를 등록하면 과거 조우가 되살아나는가** ← M1 에서 제일 빼먹기 쉬운 것
- 매핑을 풀면 그 조우가 사라지는가 (유령 전적)

> 가짜인 것은 **HTTP 경계 하나뿐**이다(`scripts/fake-riot.ts`).
> 그 위의 `RiotClient`·레이트리밋·엔진·SQL 은 운영에서 도는 코드 그대로 실행된다.

---

## 6. 워커 돌리기

```bash
npm run worker -- rank       # Engine A — 랭크 스냅샷 1회
npm run worker -- live       # Engine B — 신규 매치 따라잡기 1회
npm run worker -- backfill   # Engine C — 백필 한 조각 (--all 이면 대기열이 빌 때까지)
npm run worker -- derive     # Engine D — 조우 재파생 (--stats 면 champion_stat 도)
npm run worker -- loop       # 운영 기본값. A > B > D > C 우선순위로 상시 실행
```

`apps/web/.env.local` 을 그대로 읽는다 (`RIOT_API_KEY` 를 두 군데 두면 반드시 한쪽이 만료된다).

> ⚠️ **로컬 PGlite(`npm run dev:db`)에는 웹과 워커를 동시에 붙일 수 없다.**
> 소켓 서버가 동시 연결을 못 받아서 둘째가 `read ECONNRESET` 으로 죽는다.
> 둘 다 띄우려면 진짜 Postgres 를 쓴다.

주요 환경변수 (전부 선택. 기본값은 Development 키 기준으로 보수적이다):

| 변수 | 기본 | 뜻 |
|---|---|---|
| `RANK_HOUR_KST` | `9` | Engine A 가 도는 KST 시각 |
| `LIVE_INTERVAL_MINUTES` | `10` | Engine B 주기 |
| `LIVE_SWEEP_EVERY_TICKS` | `6` | N틱마다 전 계정 전수 조사 (놓친 경기 안전망) |
| `BACKFILL_ENABLED` | `true` | Engine C 끄기 |
| `BACKFILL_BATCH` | `25` | 한 조각에서 상세 조회할 최대 매치 수 |
| `WORKER_VERBOSE` | `false` | Riot 호출을 전부 찍는다 (리밋 디버깅) |

키가 만료되면(401/403) 워커는 **일부러 죽는다**. 0건 처리를 조용히 반복하는 것보다 낫다.

---

## 7. 첫 데이터 넣기

1. `/admin/streamers` 에서 스트리머 등록 (이름 + SOOP 아이디)
2. 상세 화면에서 **라이엇 계정 연결**
   - `RIOT_API_KEY` 가 있으면 `닉네임#태그` 를 넣으면 puuid 를 찾아 붙인다
   - 없으면 puuid 를 직접 넣는다
   - **근거(URL 또는 메모)가 없으면 등록되지 않는다.** 이건 의도된 동작이다
3. 연결하는 순간 `ingest_cursor` 에 백필 대기로 올라간다
4. `npm run worker -- loop` 를 띄우면 랭크 → 신규 매치 → 백필 순으로 알아서 긁는다
   - 이미 쌓인 매치가 있는 상태에서 스트리머를 새로 등록해도 된다.
     Engine D 가 과거 경기를 훑어 조우를 다시 만든다 (`npm run worker -- derive` 로 즉시 실행 가능)

---

## 출처

- [Developer Portal Overview — Riot Developer Relations](https://support-developer.riotgames.com/hc/en-us/articles/22698431229203-Developer-Portal-Overview)
- [Production Key Applications — Riot Developer Relations](https://support-developer.riotgames.com/hc/en-us/articles/22801383038867-Production-Key-Applications)
- [Your Application — Riot API Libraries](https://riot-api-libraries.readthedocs.io/en/latest/applications.html)
