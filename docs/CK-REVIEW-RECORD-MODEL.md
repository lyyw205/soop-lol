# CK 검수 기록 모델

작성: 2026-09-22

## 결론

검수 과정에서 사람이 읽는 문장은 `review_record` 한 표를 정본으로 삼는다.
승자·시간·구간·연결처럼 검색하거나 제약을 걸어야 하는 값은 기존 구조화 필드에 남긴다.

```text
review_record
  observation    화면에서 실제로 본 내용
  assessment     관찰을 바탕으로 내린 판단
  question       아직 해결하지 못한 질문
  final_evidence 경기 승패를 확정한 최종 근거
```

연결은 기록 종류마다 하나의 소유 대상을 갖는다.

- 프레임 관찰: `lead_id + frame_id`
- 후보 관찰·판단·질문: `lead_id + candidate_id`
- 경기의 최종 근거: `match_id`

후보는 아직 경기로 만들어지지 않았을 수 있으므로 `match_id`를 중복해서 들지 않는다.
같은 이유로 프레임 관찰에도 `match_id`를 복사하지 않는다. 그러면 경기를 삭제해 프레임이
미배정으로 돌아가도 관찰 기록은 프레임과 함께 남는다. 최종 근거에는 `lead_id`를 복사하지
않으므로 VOD 단서를 정리해도 확정된 경기의 근거는 사라지지 않는다.

## 구조화된 값으로 남기는 것

| 위치 | 남기는 값 | 이유 |
|---|---|---|
| `event_lead.raw.scan` | 요청·샘플·열어 본·실패 구간, 실행 상태 | 조사 범위와 재시도 계산에 필요 |
| `event_lead.raw.candidates[]` | `id`, `at`, `conclusion`, `match_id`, `evidence_frame_ids`, `reviewed_at` | 후보 상태와 시간축·연결을 계산해야 함 |
| `match_evidence_frame` | 파일 경로, 초, 종류, 읽은 시각, 경기 연결 | 실제 프레임과 타임라인 위치 |
| `match` | 승자, 경기 시각·길이, 공개 여부, 대회·시리즈 연결 | 공개 전적과 집계의 원본 |
| `match_participant` | 사람·계정·포지션·챔피언·KDA | 로스터와 전적 집계의 원본 |

관찰 문장을 후보 JSON, 프레임, 경기에 각각 중복 저장하지 않는다. UI의 “조사 기록 및
결과 근거”는 위 구조화된 사실과 `review_record` 문장을 함께 읽어 한 화면으로 보여준다.

## 전환 완료 (0024 → 0040)

- `0024_review_record.sql` (expand): 표를 만들고 옛 칸의 서술을 백필했다. 그 뒤 모든 저장이
  두 곳에 같이 쓰고, 화면은 "새 곳에 없으면 옛 곳" 으로 읽었다.
- `0040_review_record_cleanup.sql` (contract, 2026-09-26): 코드가 `review_record` 만 읽고 쓰도록 바꾼 뒤
  옛 칸을 걷었다.
  - `match.result_evidence`, `match_evidence_frame.note` 칸 제거
  - 후보 JSON 에서 `observed`·`why`·`open_questions` 제거 — 구조만 남는다
  - 적용 전 대조: 누락 0, 결과 근거 88건은 새 표에만 있었다(새 표가 기준)
  - **사고 복구:** 후보 2건의 `open_questions` 가 배열이 아니라 문자열로 들어와, 병합 코드가
    글자마다 질문 하나로 쪼개 저장했다(한 글자 질문 121행). 0040 이 원래 문장으로 되살렸고,
    병합 함수는 이제 문자열 배열이 아니면 거부한다.

### 입력과 저장은 다르다

조사 도구(`ck:merge`)와 시드의 **입력** 이름은 그대로다 — `result_evidence`, 프레임 `note`,
후보 `observed`/`why`/`open_questions`. core 가 받아서 `review_record` 에만 저장한다.
조회 결과(`CkMatch.result_evidence`)도 이름은 같지만 값은 `review_record(final_evidence)` 에서 온다.

### 쓰는 곳은 하나씩

| 기록 | 자동(조사·시드) | 관리자 |
|---|---|---|
| 프레임 관찰 | `recordEvidenceFrames` (관리자가 고친 프레임은 건너뜀) | 없음 |
| 후보 관찰·판단·질문 | `mergeLeadCandidates` (관리자가 고친 후보는 건너뜀) | 없음 |
| 최종 근거 | `upsertMatchFromScan`, `saveTournamentGame` | 없음 |

**관리자는 서술을 쓰지 않는다** (2026-09-26 정리). 검수 화면은 공개될 값(승패·참가자·챔피언·KDA·
시리즈 규정)과 비교 프레임, 프레임 연결, 관리자 확인·숨김만 다룬다. 서술을 고쳐야 하면 조사 도구로
다시 낸다. 조사 상태를 보는 곳은 `npm run ck:record`(읽기 전용)다.

프레임 '읽음'(`read_at`)은 메모와 무관하다 — `ck:merge` 가 `scan.opened` 또는 `frames[].read` 로만 찍는다.

## 수정 이력 (0042 `review_change`)

관리자가 고친 값은 **같은 트랜잭션**에서 전후 값으로 남는다. 값이 그대로면 남기지 않는다.

| entity | 무엇 |
|---|---|
| `match` | 승자·시각·대회 연결 등 경기 칸, 공개 여부, `admin_protected`(관리자 확인 표시·해제) |
| `series` | `best_of`·`best_of_evidence`·`set_order_known` |
| `participant` | 참가자 칸 하나하나. 행을 더하거나 뺀 것은 `field='row'` |
| `frame` | 근거 프레임의 경기 연결(`match_id`) |

경기가 지워져도 이력은 남는다(외래키 없음). 보는 곳은 `ck:record --match|--lead` 다.

질문은 적은 순서대로 읽혀야 해서 `created_at` 에 `clock_timestamp()` 를 쓴다 — 한 트랜잭션의
`now()` 는 모두 같아 순서가 무작위 `id` 로 정해졌다.

## 상태의 뜻 (관리 화면 용어는 `apps/web/lib/admin-labels.ts` 한 곳)

| 축 | 칸 | 뜻 |
|---|---|---|
| 탐색 상태 | `event_lead.raw.scan.status` | 조사 작업이 진행·종료·실패했는가 |
| 후보 결론 | `raw.candidates[].conclusion` | 경기로 반영 · 기존 경기에 연결 · 대상 아님 · 미해결 |
| 관리자 확인 | `match.reviewed_at` (프레임·후보는 각자의 `reviewed_at`) | 사람이 고치거나 확인해 **자동 갱신을 막았나**. 모든 칸을 검수했다는 뜻이 아니다 — KDA 한 칸, 근거 한 줄만 고쳐도 찍힌다 |
| 공개 여부 | `match.visibility` | 공개 화면과 집계에 넣는가. 관리자 확인과 무관하다 — 경기는 저장되는 순간 공개된다 |

`event_lead.state` 는 옛 단서 처리 단계다. 모든 행이 `confirmed` 라 조사 완료 판정에 쓸 수 없다.
소비자를 정리한 뒤 제거한다(후속).

## 사람 검수 현황 (0043)

검수 목록은 `등록 경기`, `검수 완료 n/m`, `포지션 입력 n/10m`, `참가자 연결 n/10m`, `챔피언 입력 n/10m`, `KDA 입력 n/10m`을 표시한다.
분모는 LoL 5 대 5의 참가 자리 수다. 같은 사람이 여러 경기에 나오면 각 경기에서 한 자리로 센다.
참가자 행이 8개뿐이어도 분모는 10이다. KDA는 세 값 모두 있을 때 입력 완료이며 0도 값이다.
사람 연결은 직접 연결 또는 현재 계정 소유자 연결을 센다. 숫자는 DB에서 계산하며 따로 저장하지 않는다.
등록 경기 수는 이미 저장된 경기 수이며, VOD의 모든 경기를 찾았다는 의미가 아니다.

- `reviewed_at`: 관리자 변경을 자동 재수집이 덮지 못하게 하는 보호. 화면의 완료 수에 쓰지 않는다.
- `review_completed_at`: 사람이 현재 값을 확인하고 명시적으로 완료한 시각. 기존 보호 도장으로 채우지 않는다.
- `review_version`: 오래된 화면에서 완료를 찍지 못하게 하는 내부 변경 번호. UI에는 노출하지 않는다.

빈칸이 남아 있어도 사람이 확인을 마쳤으면 완료할 수 있다. 모든 값이 채워져도 자동 완료하지 않는다.
경기 값·참가자·공유 시리즈의 BO/행사/세트 순서가 달라지면 DB가 완료를 해제한다. 같은 값 저장은 유지한다.
완료는 자동 재수집 보호도 켠다. 완료 취소는 보호를 풀지 않는다. 공개 여부도 별개다.
필터는 전체/미검수이며, 탐색 상태와 조사 서술은 CLI에만 남긴다.
포지션/참가자/챔피언/KDA 숫자에서 해당 항목의 경기 편집으로 이동한다.
포지션은 TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY, 챔피언은 ID가 0보다 큰 자리만 입력으로 센다. VOD가 없는 시드 경기도 `/admin/ck/match/[matchId]`에서 편집한다.
