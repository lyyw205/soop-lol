# 제보 판정 — 기준을 갈아 끼울 수 있는 뼈대 + 2단계(빠진 경기 등록·VOD 단서)

> 2026-10-17 설계 · **결정 완료**(§9, 같은 날 사용자). **§8 1단계(판정 뼈대) 구현** — 나머지는 §8 순서대로.
> 앞 문서: [USER-SUBMISSION-PLAN.md](USER-SUBMISSION-PLAN.md)(1단계 경기 고치기·3단계 편성표 — 지금 기준이 코드 곳곳의 if 로 박혀 있다).

## 1. 왜

사용자 결정(2026-10-17):

- 2단계는 **둘 다** 한다.
  - **가. 직접 입력**: 중복 경기가 없으면 **곧바로 공개**한다. "검증 전 · 곧 VOD 확인" 표시를 달고, **집계에서는 빠진다**.
  - **나. VOD 단서**: 공개하지 않는다.
  - 둘 다 **VOD 판독 대기열 맨 앞**에 넣는다. 판독 결과가 나오면 집계에 들어간다.
- **검증 기준은 언제든 바뀐다.**
  - 예: "3명이 같은 값을 보내면 검증", "특정 계정에 권한".
  - 기준이 바뀌어도 분기·예외가 코드 곳곳에 퍼지지 않아야 한다.
  - **이미 만든 제보(경기 고치기·편성표)도 같은 틀**로 판정한다.

지금 기준이 박혀 있는 곳은 아래와 같다. 기준 하나를 바꾸려면 이 넷을 다 찾아 고쳐야 한다.

- `holdReasonInTx`(경기 고치기 보류 이유 5종)
- `submitScheduleReport`(편성표는 언제나 보류)
- `verifySubmission`·`rejectSubmission`(운영자만 상태를 바꾼다)
- 화면의 버튼 문구

## 2. 뼈대 — 사실 → 판정 → 실행

```
 접수·+1·VOD 판독 결과·운영자 처리·권한 변경·기준 변경
        │  (무슨 일이 있었나 — 사실만 쌓는다)
        ▼
  ① 사실 모으기  gatherFacts(tx, 제보)        ← DB 를 읽는 곳은 여기 하나
        │  Facts (순수 값)
        ▼
  ② 판정        decide(Facts, 기준)          ← 순수 함수. 기준 = 규칙 목록 + 설정값
        │  Verdict { 보임, 믿음, 할 일, 이유 }
        ▼
  ③ 실행        enact(tx, 제보, 이전 판정, 새 판정)  ← 쓰기는 여기 하나(기존 쓰기 길만 부른다)
```

- **기준을 바꾸는 일은 ②만 고치는 일이다.** ①·③은 기준을 모른다.
- ②는 DB 를 모르고 순수 함수라서 단위 시험만으로 기준을 바꿀 수 있다.
- **새 사실 종류**(예: "다른 사이트 기록 일치")가 생기면 ①에 칸 하나, ②에 규칙 하나를 더한다.
- **새 동작**(예: "알림 보내기")이 생기면 ③에 동작 하나를 더한다.

### 판정(Verdict)은 두 축이다

지금의 `state` 한 칸(applied·held·verified·reverted·rejected·duplicate)에는 두 가지 뜻이 섞여 있다. 섞여 있으면 기준이 늘 때마다 조합이 늘어난다. 그래서 둘로 나눈다.

| 축 | 값 | 뜻 |
|---|---|---|
| **보임**(visibility) | `shown` · `hidden` | 제안이 공개 기록에 들어가 있나(목록에 보이나) |
| **믿음**(trust) | `pending` · `verified` · `rejected` | 집계에 넣어도 되나 |

- 공개 화면 규칙은 하나로 끝난다: **보이고(shown) 아직 믿지 않으면(pending) "검증 전"**. 집계는 `verified` 만 센다. 지금의 `pending_match` 뷰 정의 하나를 이 뜻으로 바꾸면 된다.
- 옛 `state` 는 두 축에서 계산되는 이름표로 남긴다(화면 호환).

| 옛 이름 | 보임 | 믿음 |
|---|---|---|
| applied | shown | pending |
| held | hidden | pending |
| verified | shown | verified |
| reverted | hidden | rejected(보였다가 되돌림) |
| rejected | hidden | rejected |

- `duplicate` 는 판정이 아니라 **합침**이다(제보 A → B). 판정 축 밖의 칸 `duplicate_of` 로 남긴다.

### 할 일(effects)

판정이 함께 내놓는 요청 목록이다. ③이 실행한다.

- `vod_priority`: 그 VOD 를 판독 대기열 맨 앞으로
- `admin_review`: 운영자 대기열에 올림
- `notify_reporter`: 보낸 사람에게 알림(나중)

## 3. 사실(Facts) — 판정이 볼 수 있는 것 전부

```ts
interface Facts {
  kind: "match_correction" | "schedule_report" | "match_addition" | "vod_hint";
  intake: {                       // 접수 때 본 대상의 상태(종류별)
    review_completed?: boolean; api_observed?: boolean; account_identity?: boolean;
    contested?: boolean; not_public?: boolean; duplicate_of_match?: string | null;
  };
  reporter: { roles: Role[]; sanctioned: boolean };
  agreement: { members: number; trustedMembers: number };   // 같은 지문의 서로 다른 회원 수(보낸 사람 + +1)
  vod: { state: "none" | "queued" | "agree" | "mismatch" | "not_found" | "unavailable"; mismatchCells: string[] };
  admin: { decision: "verify" | "reject" | null };
  age: { hours: number };
}
```

- `vod` 는 판독 대기열과 판독 결과에서 온다(§6).
- `agreement` 는 지금의 `submission_supporter` 를 센다.
- `reporter.roles` 는 새 권한 표에서 온다(§5).

## 4. 기준 = 규칙 목록 + 설정값

```ts
type Rule = { id: string; when: (f: Facts, c: Config) => boolean; then: Verdict };
const POLICY = { version: "2026-10-17.2", config: { trustedReporter: false, consensusMembers: null }, rules: [ /* 위에서부터 처음 맞는 것 */ ] };
```

v1 규칙은 **지금 동작을 그대로 옮긴 것**에 2단계를 더한 것이다(굵은 것이 새 규칙).

| 순서 | 규칙 id | 조건 | 판정 |
|---|---|---|---|
| 1 | `admin` | 운영자가 확인/반려 | 그대로(확인 → 보임·믿음, 반려 → 숨김·거부) |
| 2 | **`vod_agree`** | VOD 판독이 같은 판을 찾았다 | 보임·믿음(판독 값 우선) |
| 3 | **`vod_mismatch`** | 판독이 같은 판인데 값이 다르다 | §9-2 결정 |
| 4 | `sanctioned` | 보낸 사람이 제재 중 | (접수 자체를 막는다 — 지금과 같다) |
| 5 | `hold_*` | 경기 고치기의 보류 이유 5종 | 숨김·대기 + 운영자 |
| 6 | `schedule` | 편성표 제보 | 숨김·대기 + 운영자 |
| 7 | **`trusted`** | 경기 고치기 + 보낸 사람에게 `trusted_reporter` 권한(설정 `trustedReporter`) | 보임·믿음 |
| 8 | **`consensus`** | 경기 고치기 + 서로 다른 회원 N명(설정 `consensusMembers`)이 같은 값 | 보임·믿음 |
| 9 | **`addition`** | 빠진 경기 직접 입력(중복 없음) | **보임·대기 + VOD 우선** |
| 10 | **`hint`** | VOD 단서 | 숨김·대기 + VOD 우선 |
| 11 | `default` | 경기 고치기 | 보임·대기(지금의 applied) |

- **기준을 바꾸는 방법은 셋뿐이다.**
  - 줄의 순서·조건을 바꾼다.
  - 설정값을 바꾼다(예: `consensusMembers: 3`).
  - 줄을 더하거나 뺀다.
- 판정마다 `rule_id` 와 `policy.version` 을 남긴다. 그래서 "이 판은 어떤 기준으로 검증됐나"를 언제든 보여 줄 수 있다.
- **기준이 바뀌면 열린 제보를 다시 판정한다.** `reconsiderAll()` 을 돌린다. ③은 판정이 그대로면 아무것도 하지 않으므로(멱등) 몇 번 돌려도 안전하다.
- 사람이 내린 결정은 기준이 바뀌어도 뒤집지 않는다. 규칙 1(`admin`)이 언제나 맨 위에 있기 때문이다.
- **신뢰 계정·합의는 보류 아래에 둔다(구현 때 정함, 2단계 ②).** 처음 표에서는 보류 위였다. 하지만 그러면 신뢰 계정 한 명이
  공식 기록(`api_observed`)·다툼(`contested`)·검수 끝난 판을 운영자 없이 바꾼다. 그래서 이 두 규칙은 "바로 반영(확인 전)"이 될 제보를
  검증으로 올리기만 한다. 편성표 제보에도 쓰지 않는다 — 편성표는 운영자가 저장해야 바뀌므로, "검증"만 하면 반영 없이 닫혀 버린다
  (편성표용 권한은 따로 `schedule_editor` 같은 역할 + 그 반영 길을 만들 때 더한다). 바꾸려면 규칙 순서만 옮기면 된다.
- 판정이 보는 "같은 내용 회원 수"는 보낸 사람 + 같은 내용이에요(+1)다. 반영된 제보에 같은 값을 다시 보내면 "이미 그 값"이라
  거부되므로, 확인 전 제보에 동의하는 길은 +1 버튼 하나다.

## 5. 권한 — 계정에 붙는 역할

```sql
member_role (id, member_id, role, note, granted_by, granted_at, revoked_by, revoked_at)   -- 0096
-- 지금 유효 = revoked_at IS NULL, (member_id, role) 마다 하나(부분 UNIQUE). 주고 거둔 기록은 지우지 않는다(제재 표와 같은 모양).
```

- 구현 때 바꾼 것: 처음 설계의 `PK (member_id, role)` + `expires_at` 대신 기록을 남기는 줄 + 거두기 칸으로 했다.
  "누가 언제 왜 주고 거뒀나"가 남아야 권한으로 검증된 제보를 나중에 설명할 수 있다. 기한은 쓸 곳이 생기면 더한다.
- 주기·거두기는 `db/submission.ts` 의 `grantMemberRole`·`revokeMemberRole` 하나 — 회원 → 판 → 제보 순서로 잠그고
  그 회원이 보냈거나 +1 한 열린 제보를 다시 판정한다. 이미 검증된 제보는 거둬도 그대로다(그때의 기준으로 닫혔다).
- 운영 화면: 커뮤니티 운영의 회원 카드(`/admin/community?member=`)에 권한 기록·주기(사유 필수)·거두기.
  지금 기준에서 꺼진 역할은 "효과 없음"으로 알린다(`roleInEffect`). 제보 상세에 보낸 회원의 권한과 회원 카드 링크.

- 역할의 예: `trusted_reporter`(제보가 바로 검증), `schedule_editor`(편성표 제보가 바로 반영) 등.
- 역할 목록은 `metrics` 상수 하나에 둔다. DB CHECK 도 같은 목록이다.
- 역할은 **판정의 사실일 뿐**이다. 역할마다 화면이나 코드를 따로 만들지 않는다. 권한을 주거나 거두면 그 회원의 열린 제보를 다시 판정한다.
- 운영자(최고 관리자)는 지금처럼 인증 쪽에 남는다. 운영자의 확인·반려는 사실(`admin`)로 들어간다.

## 6. VOD 판독과 잇기 — 웹 ↔ 이 PC

ck-auto 의 대기열은 이 PC 의 파일(`out/ck/auto/queue.json`)이다. 배포하면 웹은 서버에서 돈다. 그래서 둘 사이를 **DB 의 요청 표 하나**로 잇는다.

```sql
vod_request (vod_id, channel_id, requested_at, priority, reason, submission_id NULL, state: queued|claimed|done|unavailable)
```

**흐름**

1. 판정의 할 일 `vod_priority` 가 요청 표에 한 줄을 쓴다. 같은 VOD 는 한 줄로 모은다.
2. ck-auto 가 매시간 목록을 갱신할 때 요청 표를 먼저 읽는다.
   - **감시 목록 밖 채널이어도** 대기열에 넣는다.
   - **이미 끝난 VOD 면 다시 연다**(기존 `ck:queue reopen`).
3. 대기열의 `claim` 정렬에 `priority` 를 더한다. 요청된 VOD 가 오래된 순서보다 앞선다.

**판독 결과 → 사실**

- 판독 세션의 프롬프트에 "이 VOD 에 회원이 등록한 경기 X(사람·시각)가 있다"를 넣는다.
- 같은 판이면 세션이 **그 경기 번호로 기록**한다(기존 `submitMatchPovInTx role:'added'` — 칸마다 일치·불일치가 남는다). 다른 번호로 새 판을 만들지 않는다.
- 이 기록을 사실 `vod.agree`·`vod.mismatch` 로 읽는다.
- VOD 에 그 경기가 없으면 `vod.not_found`, 파일이 없으면(-6303) `vod.unavailable`.

**VOD 가 없는 직접 입력** — 회원이 VOD 링크를 안 줬을 때(§9-1):

- 그날 참가 스트리머들의 VOD 를 찾아 요청 표에 넣는다.
- 찾을 VOD 가 없으면 `vod.none` 으로 남는다. 판정은 "검증 전 + 운영자"다.

## 7. 2단계 두 종류

### 가. 빠진 경기 직접 입력 (`match_addition`)

**입력**: 행사(있는 행사 고르기 또는 이름) · 날짜·시각 · 블루/레드 사람 · 세트별 승리 팀 · (선택) 챔피언·KDA · VOD 링크 · 메모.

**중복 검사(접수 때)**

- 지금의 중복 판정은 챔피언·KDA 로 한다. 회원 입력에는 그 값이 없을 수 있다.
- 그래서 **사람·날짜 규칙**을 새로 둔다(metrics, 단위 시험): 같은 KST 날짜 ±시간 창, 같은 편 사람이 N명 이상 겹치면 같은 시리즈 후보.
- 후보가 있으면 받지 않는다. "이미 있는 경기입니다 → 그 경기 고치기"로 보낸다.
- 같은 규칙을 판독 결과를 이을 때도 쓴다(§6). 그래서 같은 게임이 두 개 생기지 않는다.

**공개**

- 기존 쓰기 길(분류 쓰기 `placeSetInTx` + 경기 쓰기)로 만든다.
- 쓰는 이를 `member` 로 넓힌다. 분류 쓰기는 지금 `auto`·`admin` 만 안다. `member` 는 `auto` 처럼 사람의 행사 제외를 넘지 못한다.
- `collected_via='manual'`.
- 판정이 보임·대기라서 "**검증 전 · VOD 확인 예정**" 표시가 붙고 집계에서는 빠진다.

**검증**

- VOD 판독이 같은 판을 찾으면 판독 값이 들어가고 집계에 포함된다.
- 반려되면 숨긴다. 만든 판이라 되돌릴 이력이 없다. 그래서 반려 = 판 숨기기(기존 `visibility`)다.

### 나. VOD 단서 (`vod_hint`)

- **입력**: SOOP VOD 링크(필수) · 대략의 시점(선택) · 누가 나왔나(선택) · 메모.
- VOD 번호로 정규화한다. 같은 VOD 의 단서는 +1 로 모은다(지문 = VOD 번호 + 시점 구간).
- 판정은 숨김·대기 + VOD 우선이다. 판독이 경기를 기록하면 그 경기는 판독 경기로 바로 집계에 들어간다. 회원 값이 없으니 비교할 것이 없다.
- 단서 자체는 `vod.agree`(경기를 찾음)면 확인, `not_found` 면 "찾지 못함"으로 닫는다.

## 8. 지금 코드에서 바뀌는 자리

| 층 | 지금 | 바뀐 뒤 |
|---|---|---|
| metrics | 정규화·지문·이름표 | + `submission-policy.ts`(Facts·Rule·POLICY·`decide`) · 사람·날짜 같은 시리즈 규칙 |
| db | `submission.ts` 안의 보류 판정·확인·반려 if 들 | `gatherFacts` · `enact` · `reconsider(id)`/`reconsiderAll()`. 접수·+1·운영자 처리·판독 결과·권한 변경은 모두 "사실을 쌓고 `reconsider`"로 끝난다 |
| DB | `submission.state` | + `visibility`·`trust`·`rule_id`·`policy_version`(state 는 계산) · `member_role` · `vod_request` · kind 2개 |
| 뷰 | `pending_match` = applied 흔적 | = 보임·대기 흔적(뜻은 같고 정의가 두 축을 읽는다) |
| ck-auto | 파일 대기열, 오래된 순서 | 요청 표를 먼저 읽고 `priority` 정렬 · 요청된 VOD 는 감시 목록 밖·완료여도 연다 · 프롬프트에 회원 경기 |
| 화면 | "확인 전" | "검증 전 · VOD 확인 예정"(문구는 판정 이유로 고른다) · 운영자 화면에 판정 이유·기준 버전 |

**순서**(각 단계가 끝날 때마다 검사가 통과하는 상태로 둔다)

1. ✅ **(2026-10-17, 0095 — 운영 DB 적용)** 판정 뼈대 + 지금 두 종류를 v1 규칙으로 옮긴다. **동작 변화 0** — 기존 제보 검사가 그대로 통과했다.
   - `metrics/submission-policy.ts`(Facts·Rule·POLICY `2026-10-17.1`·`decide`·`stateOf`) — 기준은 여기 하나
   - `db/submission.ts`: 접수 사실 `matchIntakeInTx`(보류 사실을 **전부** 적는다 — 무엇이 먼저인지는 규칙이 정한다) · 접수 `admitInTx` ·
     다시 판정 `settleInTx`(보임이 바뀌면 종류별 어댑터 `ADAPTERS[kind].show/hide`) · `reconsiderOpenSubmissions`(기준이 바뀌었을 때, 멱등)
   - 운영자 확인·반려·편성표 반영 = 운영자 결정을 사실로 더하고 판정 — 따로 상태를 옮기는 코드가 없다
   - DB: `submission.intake`(접수 사실) · `admin_decision` · `rule_id` · `policy_version` — 운영자 상세에 "판정 규칙 · 기준"
   - 검사: 판정 단위 4 · verify:db(규칙 기록·같은 기준 재판정 0건·편성표 반영 = admin_verify) · 기존 제보 검사·브라우저 11단계 그대로
2. ✅ **(2026-10-17, 0096)** `member_role` + `trusted`·`consensus` 규칙(설정으로 꺼 둔 채 — 동작 변화 0).
   - `metrics/member-role.ts`(역할 목록 하나) · `db/member-role.ts`(읽기·InTx 쓰기) · 판정 사실 `factsInTx` 하나(역할·같은 내용 회원 수)
   - 사실이 바뀌는 곳(+1·권한 주기/거두기)은 그 제보를 다시 판정하고 끝난다. 접수 순간 검증(신뢰 계정)도 같은 접수 길
   - 검사: 판정 단위 7 · verify:db — 꺼 두면 그대로 / 켜고 다시 판정하면 신뢰 제보자 것만 검증·보류는 그대로 / 접수 순간 검증 /
     거두면 다음부터 확인 전·기록 남음 / 합의 N=2 는 +1 순간 검증 / 되돌린 기준으로 다시 판정 0건
3. `vod_request` + ck-auto 우선순위·다시 열기.
4. 나(VOD 단서).
5. 가(직접 입력) + 사람·날짜 중복 규칙 + 판독 잇기.

## 9. 결정 (2026-10-17 사용자)

| 질문 | 결정 | 규칙에 들어가는 모양 |
|---|---|---|
| 가에서 VOD 링크 | **선택** — 없으면 그날 참가자들의 VOD 를 찾아 대기열에 넣는다. 못 찾으면 `vod.none` | §6 |
| 판독 값 ≠ 회원 값(`vod_mismatch`) | **판독 값으로 덮고 검증** — 관측이 수기보다 강하다(원칙 8). 다른 칸은 운영자 화면에 표시만 | 규칙 3 = 보임·믿음 + 판독 값 적용 |
| VOD 로 검증 불가(`not_found`·`unavailable`·`none`) | **검증 전 유지 + 운영자** — 공개는 그대로, 사람이 판단 | 보임·대기 + `admin_review` |
| 처음 켜 둘 규칙 | **신뢰 계정·합의 둘 다 꺼 둔다** — 뼈대와 역할 표는 만들고, 처음엔 VOD 판독·운영자만 검증 | `config: { trustedReporter: false, consensusMembers: null }` |
