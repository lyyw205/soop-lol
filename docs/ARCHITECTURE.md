# 구조

core 는 **데이터와 계산**을 소유하고, 모듈은 **그걸로 만드는 것**을 소유한다.
모듈은 지워도 core 와 다른 모듈에 아무 영향이 없어야 한다.

### 무엇이 core 고 무엇이 모듈인가 (2026-09-25 결정)

- **core** — 사실(사람·계정·경기·대회·팀·순위의 저장과 수집·검수), 공개 정책(`core_public`),
  여러 기능이 같이 쓰는 계산(LP·KDA·날짜·표시 규칙). 사람 명부(`/streamers`)·프로필(`/s/[slug]`)도 core 다.
- **모듈** — 기능별 정책과 화면. 무엇을 어떻게 묶어 해석하고 보여줄지(맞대결 집계, 대회 분류·
  시리즈 점수·선수 기록 …).
- **핵심 기능도 모듈일 수 있다.** 기준은 "사이트에 중요한가" 가 아니라 "그 기능의 정책과 화면을
  떼어낼 수 있어야 하는가" 다. 상대전적(versus)·대회(tournaments)가 모두 모듈이다.
  FC 도 같다 — 상대전적(fc_versus)·대회(fc_tournaments)·리더보드(fc_leaderboard)가 모듈이고,
  FC 명부·프로필(`/fc/s`)·경기 상세(`/fc/m`)·검색 홈(`/fc`)은 core 다.
- 남은 부채(알고 두는 것):
  - FC 공개 조회는 아직 `core_public` 뷰가 없다 — 조회 안에서 공개 범위를 걸고 `verify:fco` 가 지킨다(§3).
  - FC 검색 홈의 "많이 맞붙은 스트리머" 는 core 가 FC 상대전적 모듈의 역할이 있을 때만 그리는데,
    무엇을 추천할지(`getFeaturedFcoPair`)는 아직 core 조회에 있다. LoL 홈처럼 모듈 화면을 통째로
    싣는 쪽으로 옮길지는 따로 정한다.

---

## 1. 식별자 — 주인이 셋이다

이 프로젝트에서 가장 헷갈리는 지점이다. "ID" 라는 말이 세 주인에게 동시에 쓰인다.

| 식별자 | 주인 | 불변? | 어디에 | 무엇 |
|---|---|---|---|---|
| `streamer.id` | **우리** | ✅ 영구 | `streamer` | 내부 조인 키 (uuid) |
| `streamer.slug` | **우리** | ⚠️ 바꿀 수 있음 | `streamer` | URL (`/s/kimmingyo`) |
| `streamer_channel.channel_id` | **방송 플랫폼** | ⚠️ 이론상 변경 | `streamer_channel` | SOOP 방송국 아이디 (`phonics1`) |
| `riot_account.puuid` | **Riot** | ✅ 불변 | `riot_account` | **게임 데이터의 유일한 조인 키** |
| `game_name` + `tag_line` | **Riot** | ❌ 자주 바뀜 | `riot_account` | 표시용 캐시 |
| `riot_account.summoner_id` | **Riot** | 💀 폐기 예정 | `riot_account` | league-v4 폴백용으로만 |

### 규칙

1. **"라이엇 ID" 는 컬럼이 아니다.** `game_name#tag_line` 을 사람에게 보여주는 *표현*일 뿐이다.
   실제로 겪은 것: SOOP 표기 `TT TT` ↔ 라이엇 정본 `TT  TT`(두 칸), 태그에 공백(`#산 본`).
   **조인에 쓰면 반드시 깨진다.** 항상 `puuid` 로 조인한다.
2. **"채널 아이디" 는 게임과 무관하다.** 방송 플랫폼이 발급한 것이다.
   옛 이름 `platform_user_id` 는 우리 것처럼 들려서 `channel_id` 로 바꿨다.
3. **`platform` 이라는 단어가 두 곳에서 다른 뜻이다.**
   - `streamer_channel.platform` = 방송 플랫폼 (`soop`, `chzzk`)
   - `RiotClient.platform` = Riot 라우팅 리전 (`kr`, `na1`)
   섞으면 조용히 404 가 난다. 새 코드에서는 후자를 `platformRoute` 로 부른다.

### 관계

```
streamer 1 ─── N streamer_channel   (SOOP + 치지직, 본채널/서브채널, 변경 이력)
streamer 1 ─── N streamer_account   (본계 + 부계, 근거·신뢰도 필수)
                    └── puuid ──── riot_account
```

둘 다 1:N 이고 `active_to` 로 이력을 남긴다. **비대칭이면 언젠가 걸린다.**

---

## 2. 계층

```
db/migrations/          스키마의 유일한 출처. 스냅샷 파일은 두지 않는다
packages/core/
  lib/db/               core 테이블의 유일한 쓰기 주체 (웹·워커·모듈 기준.
                        운영 스크립트의 raw SQL 은 관행상 허용하되, **부작용이 계약인
                        쓰기**(linkAccount 의 ingest_cursor 등록 같은)는 반드시 접근자를
                        경유한다 — 우회했다가 백필 큐 누락 사고가 실제로 났다)
  lib/riot/             Riot 게이트웨이 (레이트리밋·재시도·404)
  lib/metrics/          지표 계산 — 웹·워커·모듈이 같은 함수를 쓴다
  lib/ingest/           Riot 응답 → 행 변환 (순수)
  lib/contract/     ★   모듈에 노출하는 전부
packages/modules/
  registry.generated.ts 생성 등록부. 웹·워커는 이것만 본다
  <name>/
    module.json         manifest
    migrations/         mod_<name> 스키마만
    server/             집계·잡
    ui/                 화면 (선택)
apps/web/               core 화면 + 모듈 마운트(app/[...path] — 등록부의 경로를 본다)
apps/worker/            Engine A~D + 모듈 잡
```

---

## 3. 계약 5조

1. **모듈은 `@soop-lol/core/lib/contract` 만 import 한다.** `core/lib/db` 직접 접근 금지
2. **모듈은 자기 `mod_<name>` 스키마에만 쓴다.** core 테이블 쓰기 금지
3. **모듈끼리 import 금지**
4. **core·worker·web 은 특정 모듈을 import 하지 않는다.** 등록부(`@soop-lol/modules/registry`·`ui`)만 본다
5. **모듈 제거 = 디렉터리 삭제 + `DROP SCHEMA mod_<name> CASCADE`.** core 는 무변경

모듈이 import 하는 공용 UI(`packages/ui`)도 1조를 따른다 — 여기가 core 내부를 보면
모듈이 그걸 거쳐 우회한다. 공용 UI 는 **표시만** 한다: `moduleDb()`·DB 드라이버·SQL 문자열 금지.

모듈 SQL 은 **모든 테이블을 스키마로 한정해 쓴다** — 자기 `mod_<name>.*` 또는 `core_public.*`.
스키마를 생략한 이름은 search_path 로 core 원본에 닿는다.

> 이건 문서에만 적힌 약속이 아니다. `npm run verify:modules` 가 두 단계로 확인한다.
> - **경계 검사** — import 를 TypeScript 구문 트리로 읽고 경로를 해석한다(상대경로·동적
>   `import()`·재수출·타입 import 포함). SQL 은 두 겹이다. 1층은 쓰기 대상·스키마 DDL·
>   `FROM/JOIN [ONLY|LATERAL]` 을 문법 자리에서 보고, 2층은 문법과 무관하게 **이름**을 본다 —
>   남의 스키마로 한정된 이름, 남의 `mod_*`, 스키마 없는 core 테이블 이름(`db/migrations` 에서
>   읽는다)이 어디에든 나오면 실패다. 콤마 조인·서브쿼리·GRANT 처럼 1층이 모르는 형태도 2층이 잡는다.
>   **애매하면 막는다** — core 테이블과 같은 이름의 별칭·CTE, search_path 변경도 실패다.
>
> **보장 범위:** 정적 검사는 검증된 import·SQL 형태의 경계 위반을 탐지한다. 지원하지 않는
> SQL 문법과 동적 조립에는 누락이 있을 수 있으며, DB 권한 격리를 대신하지 않는다(아래).
> 목적은 내부 코드의 실수를 잡는 것이다. 알려진 누락:
> - `SELECT set_config('search_path', 'public', false)` — SQL 로 인식하지 못한다
> - `DROP VIEW mod_x.a, core_public.streamer` — 여러 대상 중 첫 번째만 본다
> - 문자열 리터럴 밖에서 런타임에 조립한 SQL
> - **검사의 검사** — 임시 복사본에 위반을 일부러 넣어 전부 잡는지, 모듈을 하나씩·전부
>   지워도 검사가 통과하고 core 가 **컴파일되는지** 본다(`scripts/verify-modules.selftest.ts`).
>
> 예전 검사는 import 문자열의 접두사만 봤다. 일부러 넣은 위반 24건 중 19건이 통과했고,
> versus 화면 경로를 박아 둬서 versus 를 지우면 검사 자체가 죽었다(5조를 검사가 깨고 있었다).
> 그 경로는 지금도 공유 표시 규칙 목록에 남아 있다 — 모듈이 없으면 건너뛸 뿐이다.
> 경로 의존까지 없애려면 그 표시 규칙 검사를 모듈 쪽 선언으로 옮겨야 한다.

### `core_public` — 왜 뷰로 막나

`visibility='hidden'` 은 지금까지 core 질의 **안에서만** 지켜졌다. 모듈이 raw 테이블을
읽으면 숨긴 부계정과 `evidence`(제보자 메모)가 그대로 샌다. 그건 삭제 요청 경로를
살려둔 의미를 통째로 없애는 구멍이다 ([PLAN §11-2](PLAN.md)).

그래서 "질의마다 조심해서 짜라"가 아니라 **뷰가 대신 거른다.**
`core_public` 뷰에는 `evidence` 컬럼이 아예 없고, 숨긴 스트리머의 행은 나오지 않으며,
조우는 **양쪽이 모두 공개일 때만** 보인다. 일반인 참가자도 걸러진다.

⚠ **DB 권한으로 막은 건 아니다.** 계약 함수는 `core_public` 만 읽지만, `moduleDb()` 는
스키마 이름 형식만 확인하고 core 와 **같은 연결**을 준다 — 모듈이 raw SQL 로 원본 테이블을
읽거나 남의 스키마에 쓰는 걸 DB 가 거부하지 않는다. 그걸 막는 건 `verify:modules` 의
정적 검사다. 신뢰하는 내부 모듈만 두는 지금은 합리적인 절충이고, 외부 모듈을 받게 되면
모듈별 DB role(자기 스키마 쓰기 + `core_public` 읽기만)로 바꿔야 한다.

FC 공개 조회(`core/lib/db/fconline.ts`)는 아직 `core_public` 뷰가 없다 — FC 를 공개 계약에
내보내지 않는다는 멀티게임 Phase 1 결정의 결과다. 그래서 원본 테이블을 읽으며 조건을 직접
걸고, 넥슨 원본 JSON(`match_info`)은 **허용 목록 키만** 내보낸다(`FCO_PUBLIC_MATCH_INFO_KEYS`).
숨긴 계정·숨긴 사람·미등록 상대의 신원이 반환값 어디에도 없는지는 `verify:fco` 가 본다.

모듈이 필요한 게 계약에 없으면 **계약에 추가하는 게 맞다.** 우회하지 않는다.

---

## 4. 왜 이벤트 버스가 아닌가

모듈이 데이터에 반응하는 방식으로 outbox + 구독을 흔히 쓴다. 여기서는 **재계산**을 택했다.

| | 이벤트 버스 | 재계산 (채택) |
|---|---|---|
| 새 모듈을 꽂았을 때 | 과거를 replay 하는 설계가 **따로** 필요 | 한 번 돌리면 과거까지 채워진다 |
| 실패 모드 | 커서 드리프트·중복·순서 | 없다 (멱등) |
| 비용 | — | 스트리머 수십 명 규모에선 초 단위 |

"꽂았다 뺐다" 가 목적이면 재계산이 오히려 더 잘 맞는다.
파생 테이블은 언제나 재계산 가능해야 한다는 원칙([PLAN §11-5](PLAN.md))과도 같은 방향이다.

지연이 실제로 문제가 되는 모듈이 나오면 **그 모듈에만** outbox 를 붙인다.
전체 구조를 미리 그쪽으로 끌고 가지 않는다.

---

## 5. 모듈 만들기

```bash
mkdir -p packages/modules/<name>/{migrations,server,ui}
```

`module.json`:
```json
{
  "name": "<name>", "version": "0.1.0", "title": "표시 이름",
  "schema": "mod_<name>",
  "routes": [{ "path": "/<name>", "title": "표시 이름" }, { "path": "/<name>/[slug]" }],
  "navOrder": 30,
  "jobs": [{ "name": "recompute", "everyMinutes": 30 }]
}
```

- `jobs[].name` 은 `server/index.ts` 의 export 이름과 같아야 한다. 자기 테이블이 없으면 잡도
  `migrations/` 도 없어도 된다(대회 모듈이 그렇다)
- **`routes[].path` 가 곧 주소다.** host 의 `app/[...path]` 가 등록부(`matchModuleRoute`)에 주소를 묻고
  `ui/page.tsx` 를 띄운다. `[name]` 한 칸이 `params.name` 이 된다. 더 구체적인 core 라우트가 언제나 먼저다
- `ui/page.tsx` 는 `{ params, searchParams }` 를 받고, `generateMetadata` 를 export 하면 host 가 제목을 거기서 받는다
- nav 에는 파라미터 없는 경로만 뜬다. core 메뉴와 `navOrder` 한 줄로 섞여 정렬된다
- `"game": "fconline"` 이면 FC 사이트 메뉴에 뜨고, FC 레이아웃 안의 마운트(`app/fc/[...path]`)가 띄운다.
  안 적으면 `lol`
- **주소를 글자로 쓰지 않는다** — core 화면(프로필·스트리머 목록·게임 홈·FC 경기)은 계약의 주소 함수
  (`profileHref(game, slug)` 등, 정본 `core/lib/site-paths.ts`)로, 자기 화면은 `module.json` 의 `routes` 를
  `routeHref(manifest.routes, 파라미터)` 에 넘겨 만든다(`ui/paths.ts`). 모듈·공용 UI 에 `/` 로 시작하는 문자열이
  있으면 `verify:modules` 가 실패한다(정적 파일 `/images/…` 만 예외). 롤 주소를 `/lol` 로 옮길 때 40곳을 고쳐야 했던
  것을 다시 겪지 않으려는 규칙이다([PLATFORM-LAYER-PLAN](PLATFORM-LAYER-PLAN.md))
- **다른 모듈 화면으로 가는 링크는 역할로 묻는다** — host 가 `roleHref(역할, 파라미터)` 를 화면에 넘기고,
  그 역할의 모듈이 없으면 null 이다. 모듈은 서로의 이름도, 등록부도 모른다(3조). core 화면도 같은 함수를
  쓴다(`apps/web/lib/module-links.ts`)
- 모듈 화면의 CSS 는 모듈이 가진다(`ui/*.css` 를 `ui/page.tsx` 가 import). 지우면 같이 사라진다
- `npm run modules:sync` 로 등록부를 다시 만든다 (`predev`/`prebuild` 에 걸려 있다)

참조 구현: `packages/modules/versus`(잡·자기 테이블), `packages/modules/tournaments`(여러 경로·계약만 읽기),
`packages/modules/fc_versus`(FC 사이트·다른 모듈로 역할 링크).

### 제거

```bash
rm -rf packages/modules/<name> && npm run modules:sync
```
```sql
DROP SCHEMA mod_<name> CASCADE;
```

core 도, 다른 모듈도 고칠 것이 없다.

---

## 6. 검증

```bash
npm test              # 순수 로직
npm run verify:db     # 마이그레이션·제약·core_public 경계
npm run verify:ingest # 수집 엔진 A~D (가짜 Riot, API 키 불필요)
npm run verify:modules # 모듈 경계 (import 그래프 + SQL) + 그 검사의 자체 검증(위반 주입·모듈 제거)
npm run verify:fco    # FC 수집·공개 조회 — 숨긴 신원이 공개 반환값에 안 남는지
npm run typecheck
```

`verify:db` 가 확인하는 것 중 이 문서와 직결된 것:
- 숨긴 스트리머가 `core_public` 에서 사라지는가
- `evidence` 컬럼이 `core_public` 에 **아예 없는가**
- 한쪽만 숨겨도 조우가 사라지는가
- 일반인 참가자가 노출되지 않는가
- 남의 채널을 조용히 뺏어오지 못하는가
