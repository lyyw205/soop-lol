# 셋업

## 0. 지금 상태 (2026-08-09)

| 항목 | 상태 |
|---|---|
| 모노레포·스키마·관리자 화면 | ✅ 완성, 검증됨 |
| 수집 워커 (Engine A~D) | ✅ 완성, 검증됨 → §6 |
| Supabase | ✅ 연결됨 — 스키마·RLS·앱 질의·트랜잭션 전부 확인 → §2 |
| 웹 (`/admin`) | ✅ Supabase 를 보고 뜬다. 인증 없으면 401 |
| Riot API 키 | ✅ Development 키 동작 확인 (account-v1·summoner-v4·league-v4 전부 200) |
| 시드 스트리머 | ✅ **40명 / 계정 44건(전부 `verified`)** — 근거는 SOOP 공식 멸망전 FA 등록 → [seed/README.md](../seed/README.md) |
| 랭크 스냅샷 | ✅ 2026-08-09 첫 스냅샷 확보 (44계정, 실패 0) |
| 매치 수집 | 🔄 진행 중 |

> ⚠️ Development 키는 **24시간마다 죽는다.** 401 이 나면 만료다 — 대시보드에서 재발급한다.
> 재발급하면 직전 키가 즉시 무효가 되므로, 두 군데에 복사해 두지 않는다.

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
| ref | `.env.local` 과 Supabase 대시보드에 있다 (공개 저장소에는 적지 않는다) |
| 리전 | `ap-northeast-2` (서울) |
| 스키마 | 적용 완료 — 테이블 15개 · `lol_lp_absolute` · **RLS 전체 ON** |

무료 플랜은 **조직당 활성 프로젝트 2개**까지라 `edu-platform` 을 **일시정지**해서 자리를 냈다
(2026-08-04 시드 데이터만 있고 5일간 활동 없음 — auth 사용자 0, 신청 0, 문의 0).
되살리려면 대시보드에서 Restore 하면 되고, 그러면 이번엔 이쪽이 자리를 비켜줘야 한다.

### 접속 경로 — **풀러를 쓴다** (직결은 WSL 에서 안 붙는다)

직결 `db.<ref>.supabase.co:5432` 는 **IPv6 전용**이다. WSL 에서는 `ENETUNREACH` 가 난다.
그래서 `.env.local` 의 기본값을 트랜잭션 풀러로 잡아 뒀다:

```
postgresql://postgres.<ref>:<PASSWORD>@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres
```

- 사용자명이 `postgres` 가 아니라 **`postgres.<ref>`** 다. 풀러는 이걸로 테넌트를 가른다
- `aws-N` 의 숫자는 프로젝트마다 다르다. 이 프로젝트는 **`aws-0`** 임을 실제로 찔러서 확인했다
  (`aws-0` → `28P01` = 테넌트를 찾고 비밀번호만 거부, `aws-1` → `XX000` = 테넌트 없음)
- `prepare` 는 [`client.ts`](../packages/core/lib/db/client.ts) 에서 이미 꺼 뒀으므로 트랜잭션 풀러로 안전하다

### DB 비밀번호

비밀번호는 API 로 가져올 수 없다. 대시보드에서 직접 받는다:
**Project Settings → Database → Database password → Reset database password** →
`apps/web/.env.local` 의 `DATABASE_URL` 안 비밀번호 자리에 넣는다.

> 붙지 않을 때 오류 코드로 원인을 가른다:
> - `28P01` — 호스트·사용자까지는 갔고 **비밀번호만** 틀렸다 → 리셋
> - `XX000` — 풀러가 테넌트를 못 찾았다 → `aws-N` 이나 사용자명(`postgres.<ref>`)이 틀렸다
> - `ENETUNREACH` — 직결(:5432)을 IPv6 없는 환경에서 쓰고 있다 → 풀러로 바꾼다

### 연결 확인 (2026-08-09)

실제로 붙여서 확인한 것:

| 확인 | 결과 |
|---|---|
| 스키마 | 테이블 15개 · RLS 15/15 ON · `lol_lp_absolute('DIAMOND','I',42)` = 2742 |
| 앱 질의 | `adminCounts` · `listStreamers` · `listIngestTargets` 정상 |
| 트랜잭션 | `linkAccount`(다중 문장 트랜잭션) + `FOR UPDATE SKIP LOCKED` 가 **풀러에서도** 돈다 |
| 웹 | `/` 200, `/admin` 인증 없으면 401 · 있으면 200 렌더 |

> 트랜잭션 풀러(:6543)는 세션 상태를 유지하지 않는다. 워커의 적재·백필이 전부
> 트랜잭션이라 여기가 막히면 M1 이 통째로 안 도는데, 위에서 실제로 돌려 확인했다.

### RLS 를 켜 둔 이유

Supabase 는 `public` 스키마를 PostgREST 로 자동 노출한다. 정책 없이 RLS 만 켜 두면
anon 키로는 아무것도 못 읽고, 우리 앱(`postgres.js` 로 소유자 롤 직결)은 영향을 받지 않는다.

이건 형식적인 조치가 아니다 — 안 켜면 `streamer_account.visibility = 'hidden'` 인 부계정과
`evidence`(제보자 메모)가 anon 키만으로 그대로 읽힌다. 삭제 요청 경로를 살려둔 의미가 사라진다.
공개 API 가 필요해지면 그때 **뷰 + 명시적 정책**으로 연다.

### 용량·잠금 점검 — `npm run ops:usage` (2026-10-12)

Free 플랜 한도(DB 500MB · 전송량 5GB/월)를 넘겨 DB 가 읽기 전용이 됐고, 그걸 모른 조사 세션이 저장에 실패했다.
그 뒤로 **대량 쓰기·조사 세션은 점검을 통과해야 시작한다.**

| 명령 | 하는 일 |
|---|---|
| `npm run ops:usage` | 잠금(기본 읽기 전용·설정 출처·Supabase 관리 상태)·DB 크기(템플릿 포함 10진 MB)·WAL·물리 디스크·큰 표·하루 증가량·지난 24시간 DB 전송 계측 |
| `npm run ops:usage -- --gate` | 관문 — 잠겼거나 한도 95%·물리 디스크 90% 이상이거나 쓰기 실패 기록이 있으면 종료 코드 3 |
| `soop-ops-usage.timer` | 매시 20분 `--record` — `out/ops/usage.jsonl` 에 쌓고, 정상이 아니면 `out/ops/ALERT` 를 쓴다(멈춤이면 서비스가 실패로 보인다) |

- **관문을 거치는 것**: 롤·FC 조사(`ck-auto.sh` — 회차 시작과 세션마다), 백필(`ck-backfill.sh` — 세션마다), 공개 큐 적재(워커 `live`·`backfill` — 조각마다).
  랭크·FC 경기·구단·시세 같은 작은 정기 수집은 막지 않는다 — 놓친 날은 다시 못 구하고 쓰는 양이 작다.
- **쓰기 실패 표시** `out/ops/write-blocked.json` — `ck:merge`·`ck:queue`·워커가 읽기 전용·디스크 부족으로 실패하면 남긴다.
  있으면 보고·정기 기록·관문 모두 **멈춤**이고, 새 세션을 띄우지 않고 진행 중인 롤 세션도 멈춘다(종료 코드 21).
  회차 시작 점검(`--gate --clear-flag`)은 **원인 해소를 확인한 표시만** 지운다 — 읽기 전용은 기본 읽기 전용 off 일 때,
  디스크 부족은 물리 디스크를 실제로 읽어(토큰 필요) 중단선 아래일 때. 원인을 모르거나 확인 못 하면 사람이 확인하고 파일을 지운다.
- **관리 API 토큰** `~/.config/soop-lol/ops.env` 의 `SUPABASE_MGMT_TOKEN`(권한 600, 저장소 밖) — soop-lol 이 있는 계정의 개인 토큰.
  없으면 Supabase 관리 잠금 상태와 물리 디스크가 **미확인**으로 나온다(정상으로 치지 않는다). 웹·조사 세션의 `.env.local` 에는 넣지 않는다.
  `ops:usage` 와 `npm run worker` 가 이 파일을 읽는다(공개 큐 적재 전 점검이 같은 토큰·한도를 보게).
- 판정은 [`packages/core/lib/db/health.ts`](../packages/core/lib/db/health.ts) 하나다. 설정 출처(`configuration file`)는 값이 어디서 왔는지일 뿐
  누가 잠갔는지가 아니다 — 그건 관리 상태로만 안다. 요금제를 바꾸면 `DB_QUOTA_MB` 로 한도를 준다(기본 500).
- **전송량 재기**: `DB_WIRE_TRACE=1 npm run …` 이면 그 프로세스가 DB 에서 받은 바이트(TLS 포함)를 끝날 때 찍는다.
  `ck-auto.sh`·`ck-backfill.sh` 는 `DB_WIRE_LOG=out/ops/db-wire.jsonl` 로 스크립트별로 남긴다. 연결 한 번이 약 12KB 다.
  누적 전송량 전체는 DB 에서 볼 수 없다 — 대시보드 Usage 의 Shared Pooler Egress 로 본다.

> 스키마를 바꿀 땐 **[`db/migrations/`](../db/migrations/) 에 다음 번호의 새 파일을 추가**한다. 이미 적용된 파일은 고치지 않는다
> (러너가 파일 지문을 장부에 남겨 바뀐 파일을 거부한다 — 빈 줄 하나도). 적용은 `npm run db:migrate`, 상태는 `npm run db:migrate -- --status`.
> 로컬 검증(`npm run verify:db`)은 같은 마이그레이션 묶음을 PGlite 에 올려 본다. `db/schema.sql` 은 없어졌다 — 다시 만들지 않는다.

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
>
> ⚠️ 같은 이유로 **개발 서버가 떠 있는 동안 다른 스크립트를 그 DB 에 붙이지 마라.**
> 커넥션을 빼앗기면 화면이 500 을 뱉는다 — 화면 버그로 착각하기 쉽다.

`out/ck/` 에 판독 프레임이 있으면 `dev:db` 가 그중 한 날짜를 골라
**CK 판독 검수 화면(`/admin/ck`)의 시드**로 넣는다(실제 프레임 경로를 쓴다).
그 화면의 이미지를 보려면 `.env.local` 에 `CK_OUT_ROOT` 를 절대 경로로 넣어야 한다.

---

## 4. 환경변수 (`apps/web/.env.local`)

```bash
# Supabase (기본). 사용자명이 postgres 가 아니라 postgres.<ref> 다.
DATABASE_URL=postgresql://postgres.<ref>:PASSWORD@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres

# 로컬 PGlite 로 되돌릴 때. 이때만 POOL_MAX=1 이 필수다.
# DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres
# DATABASE_POOL_MAX=1

RIOT_API_KEY=RGAPI-...        # 없으면 관리자 화면이 puuid 직접 입력 모드로 떨어진다

ADMIN_USER=admin
ADMIN_PASSWORD=바꿀것          # ★ 비면 /admin 이 503 으로 잠긴다 (fail-closed)
```

전체 예시는 [`apps/web/.env.example`](../apps/web/.env.example) 에 있다.

---

## 5. 검증

```bash
npm test              # 핵심 로직 단위 테스트 57개
npm run verify:db     # 스키마를 실제 Postgres 에 적용하고 제약·질의를 전부 실행
npm run verify:ingest # 수집 엔진 A~D 를 가짜 Riot 으로 끝까지 돌린다 (API 키 불필요)
npm run verify:ck     # CK 검수 회귀: 폐기 가능한 PGlite만 사용
npm run typecheck
npm run build
```

`verify:db` 가 확인하는 것:
- `db/migrations/` 전체가 순서대로 오류 없이 적용되는가
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

### 6-1. 정기 작업 (로컬 WSL, 2026-10-08)

로컬에서는 상주 워커(`loop`)를 띄우지 않고 **작업마다 systemd 사용자 타이머**로 돌린다. `loop` 는 아래 작업을
안에서 또 돌리므로 둘을 같이 쓰면 레이트리밋을 합쳐서 넘긴다. 서버 배포 뒤에는 `loop` 하나로 옮긴다.

**정기 작업의 정본은 등록부 `ops/jobs/*.json`(작업 하나 = 파일 하나)이다**(2026-10-16). 무엇을·언제·어느 잠금으로 돌리고,
어느 설치 묶음에 들고, 지우려면 무엇을 하는지가 거기 있다. 설치기는 그 목록만 읽고, `npm run verify:automation`
이 유닛·설치기·운영 화면과 어긋나는 곳(주인 없는 유닛 등)을 잡는다. 아래 표는 요약이다(ops/README.md).

| 타이머 | 명령 | 주기 (KST) | 잠금 | 놓치면 |
|---|---|---|---|---|
| `soop-rank` | `worker -- rank` | 매일 09:00 | `riot` | **그날 티어는 영영 없다** |
| `soop-fco` | `worker -- fco` | 매일 10:00 | `nexon` | 넥슨이 30일 주므로 다음 날 메워진다 |
| `soop-fco-club` | `worker -- fco-club` | 2시간마다 (:10) | `fc-site` | **지나간 날의 구단가치는 못 구한다** |
| `soop-fco-rating` | `worker -- fco-rating` | 2시간마다 (홀수 시 :40) | `fc-site` | 지나간 시점의 티어는 못 구한다 |
| `soop-fco-prices` | `worker -- fco-prices` | 매일 12:40 | `fc-site` | 365일 소급되어 메워진다 |
| `ck-auto` | `scripts/ck-auto.sh --poll` | 매시간 정각 | 조회 잠금 | 발견한 VOD를 대기 목록에 보존 |
| `ck-auto-fc` | `scripts/ck-auto.sh --fc` | 매일 07:00 | FC 실행 잠금 | 남은 맥락 미조사 경기부터 재개 |

```bash
scripts/systemd/install.sh                    # 기본 묶음: 랭크·FC 수집 5종 · 운영 DB 점검 · 운영 오피스
scripts/systemd/install.sh --with-ck-auto     # + 롤 자동 조사(목록 확인·조사) · FC 맥락 자동 조사
scripts/systemd/install.sh --bundle schedule  # 편성표(공지 수집·일정 분석) — 예전 scripts/schedule-notices/install.sh enable
scripts/systemd/install.sh --bundle community # 커뮤니티 정리 — 가입을 열 때
scripts/systemd/install.sh --status           # 작업마다 상태·마지막 실행·다음 실행
scripts/systemd/install.sh --list             # 묶음별 작업
npm run verify:automation -- --host           # 이 PC 에 설치된 유닛과 등록부 대조
journalctl --user -u soop-rank.service     # 로그
```

- 같은 출처를 쓰는 작업은 같은 잠금(`out/locks/*.lock`)을 잡아 겹치지 않는다. 앞 작업이 돌면 30분까지 기다린다.
- `Persistent=true` — PC·WSL 이 꺼져 있던 동안 놓친 회차는 켜지자마자 한 번 돈다.
- **VOD 발견과 조사는 분리한다.** 시간별 조회는 Claude를 호출하지 않고 `out/ck/auto/queue.json`에
  대기를 등록한다. `ck-auto-worker.path`가 조사 서비스를 깨우고, 롤 작업자 최대 3개가 하나씩 가져간다.
  조사 중 들어온 VOD는 빈 작업자가 다음 정각을 기다리지 않고 이어받는다. 같은 VOD는 중복 등록하지 않으며,
  같은 채널은 백필과 공통 잠금으로 겹치지 않는다. 완료·진척·반복 제한은 기존 DB 판정을 그대로 사용한다.
  아직 조사를 시작하지 않은 VOD도 `daily-state.json`의 pending으로 보존하므로 마지막 완료 지점이 앞서가도 빠지지 않는다.
- 미완료 VOD는 회차당 최대 3세션을 잇고, 남으면 1시간 뒤 다시 시도한다. 진척 없음은 6시간 뒤 재판정하며
  기존 3회 반복 제한을 적용한다. `queue.json`에는 실행 순서·소유권·재시도 시각만 두며 경기 데이터는 넣지 않는다.
  `touch out/ck/auto/STOP`은 롤, `touch out/ck/auto/FC_STOP`은 FC를 현재 세션 저장 뒤 멈춘다(다음 회차 재개).
  수동 조회는 `scripts/ck-auto.sh --dry-run`, 즉시 목록 갱신은 `systemctl --user start ck-auto.service`,
  조사 로그는 `journalctl --user -u ck-auto-worker.service`와 `out/ck/auto/run-work-*/run.log`에서 본다.
- ⚠ **WSL 은 열린 창이 없으면 스스로 꺼지고, 그동안 타이머도 안 돈다.** 윈도우 작업 스케줄러에
  로그온 시 `wsl.exe -d Ubuntu-24.04 --exec sleep infinity` 를 걸어 WSL 을 깨워 둔다.
- 일부 대상(계정·카드)이라도 실패하면 실행 기록은 `failed`, 종료 코드는 **3** 이다 — `--status` 에 실패로 보인다.
  랭크는 실패하면 20분 뒤 다시 돈다(6시간에 3번까지, 같은 날짜로 덮어쓴다). 나머지는 다음 회차가 메운다.
- **구단가치(스쿼드)와 티어는 따로 돈다**(2026-10-08 분리). 목요일 정기 점검 때 스쿼드 조회는 빈 응답(`{}`)이라 구단가치가
  실패하지만, 티어는 직전 구단 스냅샷의 신원으로 계속 받는다. 주기는 각 `.timer` 의 `OnCalendar` 만 고치면 된다
  (상주 루프는 `FCO_RATING_INTERVAL_MIN`, 기본 120분).
- 구단가치는 감독명 갱신에 넥슨 API 도 써서 `nexon`·`fc-site` 잠금을 둘 다 잡는다(FC 경기와 겹치면 넥슨 429).
- 넥슨 호출 제한(`5:1,1000:86400`)은 지금 로컬 개발 키 기준으로 코드에 고정돼 있다. 서버 키로 바꿀 때 설정으로 분리한다.

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


### CK 실제 PostgreSQL·브라우저 검증

```bash
npx playwright install chromium
CK_PG_BIN=/usr/lib/postgresql/16/bin npm run verify:ck:concurrency
CK_PG_BIN=/usr/lib/postgresql/16/bin npm run verify:ck:browser
```

`CK_PG_BIN`은 설치된 PostgreSQL의 `initdb`·`pg_ctl` 디렉터리로 바꾼다. `pg_trgm`, `pgcrypto` 확장도 설치돼 있어야 한다. 루트 계정 대신 일반 사용자로 실행한다. 두 스크립트는 직접 만든 임시 클러스터와 임의 포트만 사용하고 외부 `DATABASE_URL`을 시험 대상으로 받지 않는다. 종료 시 클러스터를 중지하고 삭제한다.

브라우저 검사는 임시 DB를 연결한 실제 Next 개발 서버를 별도 `NEXT_DIST_DIR`로 띄운다. 데스크톱·모바일 선택/저장, 두 탭의 충돌, 서버 갱신 중 입력 보존, 후보 재수집 보호를 확인한다. Playwright는 이 저장소의 고정 버전 의존성을 사용한다. 다른 저장소나 `/tmp`의 재현 스크립트에 의존하지 않는다.


## 회원 로그인 연결 (2026-10-16)

현재 로컬 상태(2026-10-17 확인): 두 제공자 키·최고 관리자·R2 설정이 존재한다(값은 문서에 기록하지 않는다). 2026-10-16 세션에서 실제 카카오·구글 가입/로그인과 R2 업로드·재생을 완료했다. 커뮤니티 정리 타이머는 enabled/active다. 운영 도메인 콜백·R2 CORS·서버 배포 확인은 별도다. 최신 작업 요약은 [release/STATUS-2026-10-17.md](release/STATUS-2026-10-17.md).

현재 회원 코드는 카카오·구글 OpenID Connect를 사용한다. 공개 열람과 실시간 캠 공유는 로그인 없이 허용한다.
실제 개발자 앱 설정 전에는 `/login`에 준비 중 안내가 나오며, 운영자 권한은 기존 관리자 인증과 별개다.

1. 카카오 개발자 앱에서 카카오 로그인과 OpenID Connect를 활성화하고 로그인 완료 주소를 등록한다.
2. 구글 개발자 콘솔에서 웹 애플리케이션 OAuth 클라이언트와 동의 화면을 구성하고 로그인 완료 주소를 등록한다.
3. 로컬 완료 주소: `http://localhost:3000/auth/kakao/callback`, `http://localhost:3000/auth/google/callback`.
   실제 접속 주소가 127.0.0.1이거나 포트가 다르면 그 주소를 별도로 등록한다.
4. `apps/web/.env.local`에 `KAKAO_CLIENT_ID`(REST API 키), `KAKAO_CLIENT_SECRET`(신규 REST API 키는 기본 활성화되어 함께 설정),
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`을 설정한다. 값은 채팅·로그·저장소에 남기지 않는다.
5. 운영에서는 `SITE_ORIGIN=https://실제도메인`을 설정하고 해당 도메인의 두 콜백 주소를 제공자에 등록한다.
   `OAUTH_KAKAO_ISSUER` 같은 가짜 제공자 설정은 운영에서 사용하지 않는다.
6. 서버를 다시 시작한 뒤 두 제공자로 가입·닉네임 설정·원래 화면 복귀·로그아웃을 실제로 확인한다.
7. 본인 회원 ID를 확인한 후 개인별 운영 권한 전환을 진행한다. 최초 가입자나 닉네임을 근거로 관리자 권한을 자동 부여하지 않는다.

로컬 권한 검증: `node scripts/verify-auth-access.ts`.
실제 연동 전에도 임시 DB로 로그인·회원 쓰기 검사를 실행할 수 있다.
공식 설정 안내: [카카오](https://developers.kakao.com/docs/ko/kakaologin/prerequisite), [구글](https://developers.google.com/identity/openid-connect/openid-connect).


### 최고 관리자 계정 (회원 로그인)

`apps/web/.env.local` 또는 배포 서버 설정:

```dotenv
ADMIN_AUTH_MODE=member
SUPER_ADMIN_MEMBER_ID=확인된_본인_회원_UUID
```

최고 관리자에게만 상단 관리자 링크와 내 정보의 최고 관리자 표시가 보인다. `/admin` 하위 화면·API·서버 액션은
로그인 세션의 유효성 및 이 회원 ID를 매번 검사한다. 로그아웃·세션 만료·탈퇴는 즉시 접근을 차단한다.
구글 로그인 사용자 전체를 관리자로 만드는 것이 아니라, 확인된 한 회원만 지정한다.
ID를 지우면 관리자 접근은 잠기며 기존 Basic 인증으로 자동 전환하지 않는다.
설정 변경은 실행 서버에 반영해야 한다(운영은 재시작). 카카오 회원과 다른 구글 회원은 일반 회원으로 유지된다.

기존 Basic을 사용하는 격리 검증 도구는 `ADMIN_AUTH_MODE=basic`을 명시한다. 운영에서 회원 모드와 Basic을 동시에 허용하지 않는다.
이 문서 앞부분의 Basic 인증 안내는 구형 설정이며, 회원 모드에서는 이 절차가 우선한다.
검증: `node scripts/verify-admin-access.ts`.


### 커뮤니티 첨부 저장소

별도 비공개 Cloudflare R2 버킷과 그 버킷에만 Object Read & Write 권한이 있는 API 토큰을 사용한다.
apps/web/.env.local의 R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY를 채운다. 키를 저장소에 커밋하지 않는다.
CORS는 실제 사이트 Origin만 허용하며 GET/HEAD/PUT, Content-Type, 노출 헤더 ETag를 설정한다. 로컬은 http://localhost:3000 및 http://127.0.0.1:3000이다. 배포 시 운영 Origin을 추가한다.

0092 마이그레이션 후 COMMUNITY_UPLOAD_ENABLED=true로 활성화한다. COMMUNITY_STORAGE_LIMIT_BYTES 기본값은 10000000000(10GB)이다. 사용자 예약/재시도는 24시간 100MB·30회 제한이다.
정리 작업은 scripts/systemd/install.sh --job community-housekeep 로 설치한다(매일 04:30, WSL이 켜져 있어야 실행). 정리 실패는 작업 실패로 남는다.
비활성화해도 기존 게시 파일 조회는 유지된다. 저장소 전체 공개와 r2.dev는 사용하지 않는다.
검증은 node scripts/verify-attachments.ts, 실제 전용 버킷 검증은 node --env-file=apps/web/.env.local scripts/verify-attachment-browser.ts 이다.
