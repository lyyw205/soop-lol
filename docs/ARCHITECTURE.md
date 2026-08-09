# 구조

core 는 **데이터와 계산**을 소유하고, 모듈은 **그걸로 만드는 것**을 소유한다.
모듈은 지워도 core 와 다른 모듈에 아무 영향이 없어야 한다.

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
  lib/db/               core 테이블의 유일한 쓰기 주체
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
apps/web/               core 화면 + /m/[module] 마운트
apps/worker/            Engine A~D + 모듈 잡
```

---

## 3. 계약 5조

1. **모듈은 `@soop-lol/core/lib/contract` 만 import 한다.** `core/lib/db` 직접 접근 금지
2. **모듈은 자기 `mod_<name>` 스키마에만 쓴다.** core 테이블 쓰기 금지
3. **모듈끼리 import 금지**
4. **core·worker 는 특정 모듈을 import 하지 않는다.** 등록부(`@soop-lol/modules/registry`)만 본다
5. **모듈 제거 = 디렉터리 삭제 + `DROP SCHEMA mod_<name> CASCADE`.** core 는 무변경

> 이건 문서에만 적힌 약속이 아니다. `npm run verify:modules` 가 import 그래프와
> SQL 문자열을 훑어 위반을 찾는다. 실제로 일부러 어겨서 3건 다 잡히는 걸 확인했다.

### `core_public` — 왜 뷰로 막나

`visibility='hidden'` 은 지금까지 core 질의 **안에서만** 지켜졌다. 모듈이 raw 테이블을
읽으면 숨긴 부계정과 `evidence`(제보자 메모)가 그대로 샌다. 그건 삭제 요청 경로를
살려둔 의미를 통째로 없애는 구멍이다 ([PLAN §11-2](PLAN.md)).

그래서 "모듈은 조심해서 짜라"가 아니라 **물리적으로 못 보게** 만든다.
`core_public` 뷰에는 `evidence` 컬럼이 아예 없고, 숨긴 스트리머의 행은 나오지 않으며,
조우는 **양쪽이 모두 공개일 때만** 보인다. 일반인 참가자도 걸러진다.

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
  "routes": [{ "path": "/m/<name>", "title": "표시 이름" }],
  "jobs": [{ "name": "recompute", "everyMinutes": 30 }]
}
```

- `jobs[].name` 은 `server/index.ts` 의 export 이름과 같아야 한다
- `ui/page.tsx` 가 있으면 `/m/<name>` 에 자동으로 붙는다
- `npm run modules:sync` 로 등록부를 다시 만든다 (`predev`/`prebuild` 에 걸려 있다)

참조 구현: `packages/modules/leaderboard`.

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
npm run verify:modules # 모듈 경계 (import 그래프 + SQL)
npm run typecheck
```

`verify:db` 가 확인하는 것 중 이 문서와 직결된 것:
- 숨긴 스트리머가 `core_public` 에서 사라지는가
- `evidence` 컬럼이 `core_public` 에 **아예 없는가**
- 한쪽만 숨겨도 조우가 사라지는가
- 일반인 참가자가 노출되지 않는가
- 남의 채널을 조용히 뺏어오지 못하는가
