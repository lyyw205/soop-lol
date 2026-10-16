# 행사 · 시리즈 · 세트 모델

작성: 2026-09-22 · **0089 로 다시 세움: 2026-10-16** — 설계 전문과 결정 이유는 [CLASSIFICATION-REDESIGN-PLAN.md](CLASSIFICATION-REDESIGN-PLAN.md).

## 구조

```text
event         행사 — format(진행 방식) 이 경기 분류의 유일한 자리
  └ match_series   시리즈 — event_id 필수. 한 판짜리도 시리즈다
       └ match        세트 — scope·map·set_role·collected_via
            └ match_participant   기본 칸만 (상세는 lol_participant_detail — 지명 계정만)
```

- 판이 어느 진행 방식인지 찾는 길은 **세트 → 시리즈 → 행사 하나뿐**이다. `match.event_id` 는 없다(옛 `COALESCE(ms.event_id, m.event_id)` 두 길 제거).
- `event.format`: 롤 ck·land·tournament·scrim·solo_bet·concept·unclassified, FC ck·tournament·concept·friendly·unclassified(게임별 CHECK = `metrics/format.ts`).
  미분류는 `unclassified` 값 하나로만 표현한다. `concept` 은 사람이 고르는 값이지 모를 때 떨어지는 칸이 아니다.
- `match.scope`: `versus`(시리즈 안 내전 세트) / `personal`(시리즈 밖 개인 기록 — 지명 수집한 솔랭 판, FC 한쪽만 스트리머인 판). CHECK 로 시리즈 유무와 묶여 있다.
- `match.map`: 롤 rift·aram·unsupported(Riot game_mode·queue_id 에서 생성), FC NULL. 맵은 분류가 아니라 세트의 속성이다.
- `match.collected_via`: api·vod·manual — 어떻게 알았나. 분류를 정하지 않는다. 토너먼트 코드 여부는 `tournament_code` 칸.

## 쓰기 — `packages/core/lib/db/classification.ts` 만

- 행사 찾기·만들기(`ensureEventInTx` — 기존 행사는 대조만, 고치지 않는다), 고치기(`updateEventInTx` — 주인만).
- 판을 시리즈에 두기(`placeSetInTx`·`placeSingleSetInTx`), 시리즈를 다른 행사로(`moveSeriesInTx`). 게임 대조·제외 확인을 여기서 한다.
- 행사 없이 들어오는 판은 **자동 미분류 묶음**(`auto_bucket`)에 담긴다 — 토너먼트 코드는 KST 날짜, FC 스트리머끼리는 (두 사람, 날짜).
  키가 판에서 정해지므로 순서·재실행과 무관하다. 사람은 묶음을 relabel 하지 않고 시리즈를 실제 행사로 옮긴다.
- "이 판은 이 행사가 아니다"는 `event_exclusion` — 현재 제약. 사람의 제외는 자동 경로가 넘지 못한다.

## best_of 규칙 (그대로)

`best_of`는 결과 스코어와 다르다. 2:0 결과만 보고 Bo3이라고 역산하지 않는다. 양의 홀수만, 근거(`best_of_evidence`) 필수,
같은 시리즈에 다른 값이 들어오면 덮지 않고 멈춘다(`series.ts` 의 `validateBestOf`, `ensureSeriesInTx`).

## 세는 법 — `packages/core/lib/metrics/tally.ts` 만

- 세트 = 본게임 한 판. 시리즈 = 그 시리즈에서 센 세트들로 — W > L+U 면 승, L > W+U 면 패, W = L 이고 미상 0 이면 무, 그 밖은 미상.
  CK·대회·랜드가 같은 규칙이다(랜드: 매 판이 세트, 그날 묶음이 시리즈). 일부 세트만 뛴 사람은 본인이 뛴 세트로만.
- 보너스 판(`set_role='bonus'`)은 어떤 집계에도 들어가지 않는다 — 펼친 목록(`core_public.match_detail`)에만.
- 상대전적 한 세트는 두 사람의 결과 짝으로(`pairSetOutcome`) — 언제나 대칭. 양쪽 패(FC 양쪽 몰수)는 무.

## 공개 읽기

`core_public.versus_set`(= `lol_versus_set` ∪ `fc_versus_set`) · `versus_pair_set` · `personal_game` · `match_detail` · `event` · `event_dates`.
공개 집계는 이 뷰와 `tally` 만 쓴다(`verify:modules` 가 옛 이름을 막는다). 파생 표(조우·챔피언 통계)는 없다 — 운영 규모 실측으로 질의당 200ms 이하.
