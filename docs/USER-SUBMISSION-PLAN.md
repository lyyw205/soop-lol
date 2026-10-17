# 사용자 제보 — 설계

> 2026-10-16 작성 · **확정**(결정 §10) · **1단계 구현·운영 적용**(§11 — 뼈대 + 경기 고치기③, 0093 2026-10-16).
> **3단계 편성표 제보 구현**(§12 — 0094, 2026-10-17). 2단계 = 시리즈 등록·VOD 단서(①)는 남았다. 아이디어(④)는 이미 있는 건의·문의(`/support`).

## 1. 왜 · 무엇을 지키나

경쟁 사이트는 기록을 사용자 제보로 채우고, 그래서 누락·오기가 가장 큰 불만이다(docs/marketing/customer-research.md — 피드백 35건 중
누락 15·정정 12, 같은 정정이 5번). 제보는 우리 기록의 구멍을 빨리 메운다. 단 **제보가 사실처럼 보이면 안 되고**(원칙 3·8),
**제보만의 쓰기 길을 따로 만들면 안 된다** — 판을 고치는 길이 둘이 되면 근거·잠금·이력 규칙 중 하나가 반드시 빠진다.

## 2. 지금 구조에서 제보가 들어갈 자리 (조사 결과)

| 지금 있는 것 | 제보가 쓰는 방법 |
|---|---|
| 판 고치기의 단일 경로 `applyMatchReviewInTx`(ck.ts) — 칸마다 기대값 대조, 이력(review_change), 승패 재계산 | **그대로 지난다.** 쓰는 이가 누구인지(actor)만 인자로 더한다 |
| 이력 `review_change.actor` = admin·auto 둘뿐, `recordReviewChanges` 는 actor 를 안 받아 언제나 admin | actor 에 **member** 를 더하고 `submission_id` 칸을 둔다(member 일 때만, CHECK). 이 이력이 되돌리기의 원본이다 |
| 자동 판독의 칸 보호(review-lock.ts) — admin 이 고친 칸만 사람 칸 | member 칸도 사람 칸으로 본다 — 판독이 제보를 덮으면 표시만 남고 값이 사라진다 |
| 분류 쓰기 `classification.ts` — auto 는 사람의 행사 제외를 못 넘는다 | 1단계 제보는 분류를 바꾸지 않는다(여러 판에 걸친다 — §4 보류). 2단계 등록은 member 를 auto 처럼 다룬다(사람 제외를 못 넘는다) |
| 공개 집계 뷰 `lol_versus_set`·`versus_pair_set` — 보너스판을 **WHERE 한 곳**에서 뺀다. 모든 집계가 이 뷰만 읽는다 | 확인 전 판도 **같은 한 곳**에서 뺀다(결정 A). 집계 코드는 한 줄도 안 바뀐다 |
| 목록(개인 매치 히스토리·상대 전적 목록·상대전적 상세)은 집계와 같은 행을 `foldSeries` 로 접는다 | 목록은 확인 전 판까지 포함한 **목록용 뷰**를 읽고, 행마다 `pending` 칸을 받는다. `tally` 가 pending 행을 세지 않는 것이 유일한 규칙이다 |
| 회원 세션·잠금·제재(member.ts·community_sanction)·건의함(support_ticket)의 접근자 모양 | 그대로 따른다 — 회원 행 잠금 → 한도 → 제재 → 쓰기 |
| 신고(UNIQUE 회원×대상)·추천(ON CONFLICT DO NOTHING)·VOD 단서(자연키 병합) | 중복 막기 네 겹(§6)의 재료 |

## 3. 뼈대

```
submission            제보 하나 — 보낸 회원 · 종류 · 대상 · 제안(정규화된 JSON) · 지문 · 메모·근거 · 상태 · 처리 기록
submission_supporter  "같은 내용이에요(+1)" — 회원×제보 하나
submission_effect     이 제보가 바꾼 판 — 확인 전 표시(core_public.pending_match)가 읽는다
review_change         (기존) 바뀐 칸의 전후 값, actor='member', submission_id
```

**상태**

| 상태 | 뜻 | 화면 |
|---|---|---|
| `applied` | 바로 반영됨, 운영자 확인 전 | 그 판에 **확인 전** 표시, 집계에서 빠짐 |
| `held` | 반영하지 않고 운영자에게만(§4) | 공개 화면 변화 없음 |
| `verified` | 운영자 확인 — applied 는 표시를 떼고, held 는 운영자가 반영 | 표시 없음, 집계에 들어감 |
| `reverted` | applied 를 운영자가 반려 — 남긴 값을 되돌림 | 원래 값 |
| `rejected` | held 를 운영자가 반려 — 바뀐 것이 없음 | – |
| `duplicate` | 다른 제보와 같은 내용으로 합침 | – |

## 4. 바로 반영하나, 보류하나

제보가 바로 바꾸는 것은 **그 판 하나의 칸**(승리 팀·참가자의 스트리머·챔피언·포지션·KDA, 참가자 추가·삭제)뿐이다. 아래는 `held`:

| 보류 이유 | 왜 |
|---|---|
| 운영자가 **검수 완료**한 판(결정 B) | 사람이 본 값은 사람이 다시 봐야 바뀐다 |
| Riot API 로 모은 판(`collected_via='api'`) | 관측값이다 — 제보가 덮을 근거가 약하다 |
| 계정이 있는 자리의 사람 바꾸기 | 계정 연결 문제다(부계정 분쟁 — 원칙 2). 계정 후보로만 |
| 다른 확인 전 제보가 **같은 칸을 다른 값으로** 이미 바꿨다 | 값이 오락가락하지 않게 — 운영자가 둘을 같이 본다 |
| 여러 판에 걸친 것(시리즈 묶기·행사 진행 방식) | 한 사람의 제보로 여러 판·집계가 한꺼번에 흔들린다 |

## 5. "확인 전"과 집계 (결정 A)

- 원본 판 하나가 확인 전인지 = **applied 제보의 흔적(submission_effect)이 있는가**. 저장된 칸이 아니라 뷰가 계산한다(원칙 5).
- 뷰 층:
  ```
  lol_set_row      공개 본게임 세트 (사람, 세트) + pending          ← 목록이 읽는다
  lol_versus_set   = lol_set_row WHERE NOT pending                ← 집계가 읽는다(지금 그대로)
  lol_pair_row     같은 판의 두 사람 + pending                    ← 상대 전적 목록이 읽는다
  versus_pair_set  = lol_pair_row WHERE NOT pending ∪ FC          ← 상대 전적 집계(지금 그대로)
  match_detail     + pending 칸                                    ← 경기 보기·대회 화면
  ```
  짝 찾기·신원 규칙은 각각 한 번만 정의된다 — 집계 뷰는 목록 뷰의 거르기다.
- `tally` 는 `pending` 행을 세지 않는다(단일 규칙). `foldSeries` 의 줄 점수·결과도 그것을 따른다. 그래서 목록 줄의 점수와 요약 카드가 같다.
- match_detail 로 직접 세는 곳(대회 점수·대진·대회 목록의 판 수)은 pending 을 거른다 — 검사(`verify:modules`)가 그 자리를 지킨다.
- 표시는 공통 행 컴포넌트에서 `확인 전` 칩 하나. "제보로 정정됨"은 없다(사용자 결정).

## 6. 중복 막기 — 네 겹

| 겹 | 막는 것 | 방법 |
|---|---|---|
| 1. 요청 키 | 두 번 누르기·새로고침·재시도 | 폼마다 요청 번호(uuid) — `UNIQUE(author_id, request_id)`. 같은 요청은 같은 제보를 돌려준다 |
| 2. 내용 지문 | 다른 사람의 같은 제보 | 대상 + 정규화한 제안의 sha256 — **열린 제보(applied·held) 중 유일**(부분 UNIQUE). 같으면 새 행 대신 +1 |
| 3. 같은 칸 | 같은 칸을 다른 값으로 | 열린 제보가 이미 바꾼 칸이면 새 제보는 `held`(§4) |
| 4. 이미 그 값 | 바뀌는 것이 없는 제보 | 지금 값과 같은 칸은 지우고, 남는 게 없으면 받지 않는다("이미 그 값입니다"). 화면이 본 값이 지금과 다르면 "그 사이 바뀌었습니다" |

- 쓰기 전에 화면이 그 판의 열린 제보를 먼저 보여 준다 — "이미 접수된 제보 2건 · 같은 내용이에요(+1)".
- 동시에 같은 제보 두 개가 들어와도 부분 UNIQUE 가 하나만 남긴다(23505 → +1 로 바꾼다).
- 한도: 회원당 하루 20건(+1 은 세지 않는다, 결정 C). 커뮤니티 제재 중인 회원은 제보도 막힌다(제재 하나로 — 개념을 늘리지 않는다).

## 7. 운영자

- `/admin/submissions` — 열린 제보를 판별로 묶고(+1 많은 것·오래된 것 먼저), 전후 값과 근거를 나란히. 검수 화면(`/admin/ck/match/[id]`)으로 바로.
- **확인**(applied → verified: 표시만 뗀다 / held → verified: 운영자 이름으로 반영) · **반려**(applied → reverted: 되돌림 / held → rejected) · **중복**.
- 되돌리기는 그 제보의 이력(submission_id)만 역순으로 되돌린다. 그 뒤 누군가 같은 칸을 또 바꿨으면 **하나도 되돌리지 않고** 충돌 칸을 보여 준다
  (운영자가 검수 화면에서 직접 고친 뒤 확인). 되돌리기는 운영자 이름의 고치기다 — 운영자가 원래 값이 맞다고 본 것이라 그 칸은 사람 칸으로 남는다.

## 8. 개인정보 · 탈퇴

- 제보 내용·보낸 사람은 본인과 운영자만 본다. core_public 에는 `pending` 칸만 있다.
- 탈퇴하면 메모·근거 글을 지우고 보낸 사람 연결을 끊는다(+1 도 지운다). **반영된 값과 이력은 남는다** — 데이터의 이력은 회원의 글이 아니다.

## 9. 자리

| 층 | 무엇 |
|---|---|
| DB(0093) | 표 셋 · review_change actor/submission_id · 뷰 층(§5) · 탈퇴 트리거 |
| core | `lib/db/submission.ts`(접수·보류 판정·지문·+1·확인·반려·되돌리기·목록) · `lib/metrics/submission.ts`(정규화·지문·한도 상수) · ck.ts `applyMatchReviewInTx` actor 인자 · review-lock member · tally pending |
| web | `/submit/match/[id]`(로그인 필수) · `/submissions`(내 제보) · `/admin/submissions` · 행 컴포넌트의 확인 전 칩·제보하기 링크 |
| 계약 | 모듈 화면(상대전적 상세)이 제보 주소·pending 을 받는 길 — `site-paths` 의 `submitMatchHref` |
| 검사 | verify:db 제보 절(접수·중복 네 겹·보류·반영·집계 제외·목록 포함·되돌리기·충돌·확인·탈퇴) · verify:modules(match_detail 직접 집계의 pending 거르기) |

## 10. 결정 (2026-10-16 사용자)

로그인 필수 · 1단계는 ①·③ 중 ③ 먼저 · 제보는 바로 등록 + 확인 전 표시, 운영자 검수 뒤 뗌 · 정정됨 표시 없음 · 비공개 ·
A 확인 전은 목록에 보이고 집계는 확인 뒤 · B 검수 완료 판은 보류 · C 하루 20건 · 중복 막기는 표준 방식(§6).

## 11. 1단계 구현 (2026-10-16)

| 층 | 파일 |
|---|---|
| DB | `db/migrations/0093_user_submission.sql` — submission·submission_supporter·submission_effect, review_change actor member + submission_id, 탈퇴 트리거, `core_public.pending_match`(확인 전의 유일한 정의) · `lol_set_row`/`lol_pair_row`(목록) → `lol_versus_set`/`versus_pair_set`(집계 = NOT pending), match_detail.pending |
| core | `lib/db/submission.ts`(접수·네 겹·보류·반영·확인·반려·중복·목록) · `lib/metrics/submission.ts`(정규화·지문 재료·칸 주소·한도·이름표·읽는 줄) · `ck.ts` ReviewWriter(admin·member) · review-lock member=사람 칸 · `tally`·`foldSeries` 의 pending(=`counted`) · 목록 함수 `listed` 선택(personal·opponent-history) · 대회 점수·선수 기록·대진·대회 목록 판 수도 counted |
| web | `/submit/match/[id]`(폼 + 열린 제보 + +1) · `/submissions`(내 제보) · `/admin/submissions`(대기열·상세·확인/반려/중복) · 대시보드 할 일 · 세트 보기의 확인 전 칩·제보하기 링크(packages/ui/match-details) · 시리즈 줄 확인 전 칩 |
| 검사 | `verify:db` 제보 절 35개(scripts/lib/verify-submission-db.ts) · `verify:modules` "확인 전 — 세는 규칙 하나"(화면이 pending 으로 직접 거르기 금지, match_detail 직접 집계는 pending 거르기) · tally·foldSeries 단위 시험 |

- 운영 미리보기(되돌림): 0093 0.6초. 집계·목록 질의 속도는 전과 같다(±20ms). 적용 직후 첫 질의만 2.3초(새 표 통계 없음) — 적용 뒤 ANALYZE.
- 2026-10-17: 관리자 메뉴 "회원 제보"·`/me` 의 "내 경기 제보 확인" 링크, 브라우저 검사 `npm run verify:submission:browser`(폐기 PGlite + Next — 비로그인 안내 · 세트 보기 제보하기 → 바뀐 칸만 반영 · 상대전적의 확인 전 · 다른 회원 +1 한 번 · 내 정보 → 내 제보 · 모바일 가로 넘침 없음 · 관리 메뉴 → 대기열 → 확인 · 일반 회원 403 · 확인 뒤 확인 전 사라짐).
  +1 을 누르면 그 회원도 제보에 낀 사람(`mine`)이 되어 버튼이 빠지고 "같은 내용 N" 이 오른다 — 안내 문구 대신 숫자가 응답이다.
- 남은 것: 2단계(① 시리즈 등록·VOD 단서). 외부 공개는 운영 도메인 로그인·배포 검증 뒤.

## 12. 3단계 — 편성표 제보 (2026-10-17)

**결정(사용자):** 회원은 편성표를 **제보만** 한다(있는 일정 고치기 · 빠진 일정 알리기) · **둘 다 운영자 승인 뒤** 공개 · 근거 링크는 **새 일정만 필수**.

그래서 경기 제보와 모양이 다르다 — 바로 반영·확인 전 표시·되돌리기가 **없다**. 공개 화면이 바뀌는 것은 운영자 저장뿐이다.

| 경기 제보(1단계) | 편성표 제보(3단계) |
|---|---|
| 접수 = 바로 반영(applied) 또는 보류 | 접수 = 언제나 보류(`held`, `schedule_review`) |
| 반영은 `applyMatchReviewInTx`(actor member) | 반영은 운영자의 `saveScheduleEntry` — 제보 내용으로 **미리 채운 편집 폼**을 저장하면 같은 트랜잭션에서 확인 완료(`closeScheduleReportInTx`) |
| 확인 전 표시·집계 제외·되돌리기 | 없음(반영 전엔 공개 화면이 그대로다) |

- **제안 모양**(`metrics/submission.ts` `ScheduleReport`): 종류(correction·new) · 게임 · 제목 · 상태(예정대로·취소·연기, 고치기만) · 날짜(KST) · 시작 시각(HH:MM, 비우면 미정) · 참가자(이름 글자).
  편성표 저장 입력(`ScheduleInput`)이 아니라 회원이 아는 만큼이다. 참가자는 이름 글자 — 운영자 폼이 등록된 스트리머의 표시 이름·slug 와 **정확히 같은 것만** 넣고 나머지는 이름으로 보여 준다.
- **중복 막기:** 같은 요청 · 같은 지문(+1) · 이미 그 값(지금 일정과 같은 칸은 지운다 — 방송 칸이 하나일 때만 날짜·시각을 대 본다) · 하루 한도(경기 제보와 같이 20건). 메모만 있는 고치기는 메모까지 지문에 넣는다.
  새 일정은 잠글 행이 없어 같은 지문끼리 advisory 잠금으로 줄을 세운다.
- **운영자:** `/admin/submissions` 에 "편성표" 꼬리표로 같이 온다 → 상세의 **편성표 편집에서 반영 →**(`/admin/schedule/<일정|new>?submission=<제보>`) → 미리 채운 폼(제보 줄·근거·메모·맞지 않은 이름·여러 칸 경고) → 저장.
  저장이 실패하면(그 사이 바뀐 일정 등) 제보도 열린 채다. **반영 없이 확인**(이미 고쳤거나 고칠 것이 없다) · 반려 · 중복은 경기 제보와 같다.
- **진입:** 일정 모달·일정 상세의 **제보하기** · 편성표 머리의 **빠진 일정 알리기 →** — 주소는 `site-paths` 의 `submitScheduleHref`(계약으로 모듈에 준다).

| 층 | 파일 |
|---|---|
| DB | `0094_schedule_report.sql` — kind `schedule_report` · `submission.schedule_entry_id`(새 일정은 반영 때 채운다) · hold_reason `schedule_review` · 모양 CHECK(편성표 제보는 applied·reverted 없음) |
| core | `db/submission.ts`(`submitScheduleReport` · `listOpenOnSchedule` · `getScheduleReportTarget` · `closeScheduleReportInTx`) · `db/schedule.ts` `saveScheduleEntry({ submission })` · `metrics/submission.ts`(정규화·읽는 줄·`submissionLines`) |
| web | `/submit/schedule/[entryId]`(new 포함) · 내 제보·운영자 대기열·상세의 종류별 줄 · 편성표 편집의 미리 채우기(`lib/schedule-report-prefill.ts`) |
| 모듈 | schedule 모달·상세의 제보하기, 편성표 머리의 빠진 일정 알리기 |
| 검사 | `verify:db` 편성표 제보 절 23개(scripts/lib/verify-schedule-report-db.ts) · `verify:submission:browser` 편성표 4단계(상세 → 취소 제보 → 빠진 일정 → 운영자 반영·새 일정 등록) |
