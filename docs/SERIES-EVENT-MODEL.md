# 대회 · 시리즈 · 매치 모델

작성: 2026-09-22 · 구현 반영: 2026-09-23

## 현재 구조

```text
event
  └ match_series       다전제 하나의 정본
       └ match         한 세트
```

- `match_series.id`: 기존 사람이 읽을 수 있는 `series_id`를 그대로 쓴다.
- `match_series.game_code`: 서로 다른 게임이 같은 시리즈 키에 섞이지 않게 한다.
- `match_series.event_id`: 시리즈가 속한 대회/내전의 정본이다.
- `match_series.best_of`: Bo1/Bo3/Bo5 같은 예정 최대 세트 수다.
- `match.series_id`, `series_game_no`: 세트가 어느 시리즈의 몇 번째 판인지 나타낸다.
- `match.event_id`: 시리즈가 없는 단판 이벤트 경기에서만 쓴다.

시리즈가 있는 경기의 유효 event는 `match_series.event_id`, 단판은 `match.event_id`다.
공개 계약은 이 둘을 `COALESCE(match_series.event_id, match.event_id)`로 한 칸에 내보낸다.
`match_series_owns_event` 제약은 시리즈 세트에 `match.event_id`가 복제되는 것을 거부한다.

## best_of 규칙

`best_of`는 결과 스코어와 다르다. 2:0 결과만 보고 Bo3이라고 역산하지 않는다. 끝까지 가지
않은 Bo5도 2:0 시점에는 구분할 수 없기 때문이다.

- 양의 홀수만 허용한다.
- 고정 2세트제와 포맷 미확정은 `NULL`이다.
- 값을 넣으려면 규정 URL이나 VOD 시각 같은 `best_of_evidence`가 반드시 필요하다.
- 같은 시리즈에 다른 값이 들어오면 writer가 덮지 않고 오류로 멈춘다.

대회 시드는 `series_formats`에 시리즈별 규정과 근거를 적는다. CK 조사 결과는
`best_of`, `best_of_evidence`를 함께 보낸다. 어드민도 두 값을 한 묶음으로 편집한다.

## 쓰기와 읽기 계약

- `ensureMatchSeries()`가 CK와 대회 시드의 공통 생성·충돌 검증 경로다.
- `(series_id, game_code)` 복합 FK가 다른 게임 시리즈로의 연결을 막는다.
- 시리즈 event를 다른 값으로 조용히 옮기지 않는다. 영향 범위가 모든 세트이므로 별도
  검수 없이 한 경기 편집으로 바뀌어서는 안 된다.
- 대회 종류 변경, 조우 재파생, 챔피언 통계, 시드 prune, CK 도구는 모두 유효 event를 읽는다.
- `core_public.match`와 `core_public.streamer_encounter`가 `best_of`를 공개 화면에 전달한다.

## 마이그레이션

`0027_match_series.sql`은 기존 시리즈를 이관한 뒤 FK를 건다. 현재 운영 데이터의
`ck-2026-09-19-sangho-mansik:series1/series2`는 저장된 VOD 근거를 바탕으로 Bo3를 채운다.
운영 DB 적용 전에는 preflight가 한 시리즈가 여러 게임이나 여러 event에 걸치지 않는지
확인하며, 애매하면 추측해서 합치지 않고 중단한다.

## 여전히 별도인 것

FC온라인 API가 여러 경기를 하나의 시리즈로 묶어 주는지는 아직 확인되지 않았다.
그러므로 FC 친선 연속전을 시간만 보고 자동 시리즈로 만들지 않는다. 실제 응답과 제품상
묶음 의미를 확인한 뒤 명시적으로 `match_series`를 만들거나 단판으로 둔다.

## 랜드와 보너스 판 (0079, 2026-10-07)

진행 방식의 정의는 [CK-COLLECTION.md §3.5](CK-COLLECTION.md)다. 스키마로는 이렇게 표현한다.

| 진행 방식 | 표현 | 히스토리 | 집계 |
|---|---|---|---|
| CK·대회 다전제 | `match_series` (팀 고정) | 시리즈 한 줄 | 세트·매치(과반 승) |
| 랜드 | `event.kind='land'` + 이벤트마다 `match_series` 하나(`<slug>:land`, best_of 없음) | 랜드 한 줄, 그 사람의 판 단위 n승 m패 | **판 단위**. 공개 조우 뷰는 랜드의 `series_key`를 판 자신으로 낸다 |
| 보너스 판(범인찾기 등) | `match.set_role='bonus'` + 앞 본게임의 `series_id`, 부른 이름은 `set_label` | 그 시리즈를 펼치면 마지막에 보인다 | **없음**. `core_public.match`·`streamer_encounter`·`champion_stat`은 본게임만 |

- 보너스는 반드시 어떤 시리즈에 붙는다(`match_bonus_in_series`). 붙일 본게임이 없으면 보너스로 표시하지 않는다.
- 히스토리 표시는 `core_public.match_with_bonus`, 승패를 세는 곳은 `core_public.match`다.
- 칼바람으로 한 랜드는 맵이 먼저라 칼바람(`aram_custom`)으로 분류되고, 묶음은 그대로다.
