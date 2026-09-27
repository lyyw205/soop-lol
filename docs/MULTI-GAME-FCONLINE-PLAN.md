# 멀티게임 · FC온라인 전환 계획

이 문서는 LoL을 유지한 채 FC온라인을 두 번째 수집 게임으로 붙이는 실행 기준이다.
게임은 설치·삭제되는 기능 모듈이 아니라 코어가 소유하는 데이터 공급자다. 기능 모듈은
`core_public` 계약만 읽으며 코어 테이블을 쓰지 않는다.

## 1. 고정 원칙

- 저장 단계부터 모든 경기는 `game_code`로 구분한다. 화면에서 이름이나 ID 접두사로 추측하지 않는다.
- LoL과 FC온라인은 게임별로 조회할 수 있고, 통합 화면은 명시적으로 두 게임을 합친 계약만 사용한다.
- Phase 1의 기존 `core_public` 계약은 LoL 전용이다. FC 행이 기존 LoL 화면에 우연히 섞이지 않게 뷰에서 차단한다.
- `match_id`는 사람이 추적 가능한 text PK를 유지한다. Riot의 `gameId`는 `riot_game_id`로 이름을 분리한다.
- 공통 사실은 코어에 두고 공급자 응답·커서·재조회 정책은 게임별 어댑터가 책임진다.
- OUID의 불변 보장은 확인되지 않았다. 불변성에 의존하지 않고 opaque 식별자로 취급하며 닉네임과 연결 이력을 보존한다.
- 없는 값은 합성하지 않는다. FC 무승부는 승/패로 합성하지 않고 `outcome='draw'` 하나로 표현한다. 승패의 표현은 `outcome` 한 칸뿐이다 — boolean `win` 은 0028 에서 은퇴했다.
- 일반화는 FC 실데이터의 형태가 확인된 뒤 한다. 기존 Riot 디렉터리와 공개 계약을 먼저 옮기지 않는다.

## 2. 구현 상태

### 적용됨 — 멀티게임 저장 경계

- `match.game_code`, `mode_key` 추가, 영구 기본값 없이 명시 입력 강제
- `match.game_id`를 `riot_game_id`로 변경
- `source='provider_api'` 허용
- FC에 없는 `queue_id`, `team_id`, `champion_id`의 nullable 전환; boolean `win` 은 0028 에서 `outcome` 으로 이관 후 제거
- 공통 `side_no`, `outcome`(NOT NULL, 승패의 유일한 표현) 추가
- `streamer_encounter.game_code`, `mode_key`, `a_outcome`, `b_outcome`(NOT NULL) 추가
- `streamer_encounter.queue_id` nullable 전환; `a_win`·`b_win` 은 0028 에서 `a_outcome`·`b_outcome` 으로 이관 후 제거
- LoL writer는 새 공통 필드를 함께 기록
- `champion_stat` 재계산은 `m.game_code='lol'`을 SQL 조인에서 강제
- `core_public.match`, `match_participant`, `streamer_encounter`는 뷰 자체에서 LoL만 노출
- 공급자별 `NexonClient`와 개발 키 기준 독립 rate-limit bucket 추가
- `/id`, `/user/basic`, `/user/match`, `/match-detail` 응답 타입과 오류·재시도 계약 추가
- `npm run fco:probe -- --nickname "감독명"` Phase 0 점검 도구 추가
- `match_series`를 시리즈 정본으로 도입하고 event·best_of·근거를 세트 행과 분리

회귀 검증은 FC 1:1 무승부 한 건을 실제로 넣고 다음을 확인한다.

1. 조우가 `NULL + draw`로 파생된다.
2. LoL 챔피언 통계 재계산이 성공하고 결과가 변하지 않는다.
3. 세 `core_public` 뷰에서 FC 행이 0건이다.

## 3. 단계별 실행

### Phase 0 — 실제 응답 고정

- 개발 키 인증과 `교로텔리`, `메시연`의 `/id → /match → /match-detail` 실응답을 확인했다.
  원본 fixture는 gitignore 된 `out/fconline/`에 보관한다.
- 공식 친선(matchtype 60) 상세는 두 표본 모두 참가자 2명과 상대 OUID를 제공했다.
  따라서 1:1 매치와 조우 자동 생성의 응답 전제는 충족됐다.
- `matchDate`는 시간대 표기 없는 UTC0 문자열로 내려오는 것을 확인했다. 시작/종료 중 어느
  시각인지는 응답만으로 증명할 수 없으므로 VOD 또는 실제 플레이 시각 대조 전까지 미확정이다.
- 오래된 경기의 재조회 가능 범위와 API 이용 조건은 넥슨에 문의하되 구현 블로커로 삼지 않는다.
- LoL 공개 큐 실데이터를 한 번 운영 경로로 통과시켜 기존 Riot 경계도 실제 응답으로 검증한다.

### Phase 1 — FC온라인 최소 수집

- `packages/core/lib/games/fconline/`에 클라이언트·응답 타입·변환기를 신설한다. 기존 `riot/`는 이동하지 않는다.
- `fco_account`와 `streamer_fco_account`를 별도로 둔다. 현재 닉네임과 OUID 연결 이력을 보존한다.
- 원본 FC 상세에서 다시 만들 수 없는 공급자 전용 필드만 `fco_match_detail`에 둔다.
- 공급자별 실행 루프와 rate-limit bucket을 분리한다. Riot의 단일 루프에 FC 요청을 끼워 넣지 않는다.
- FC 신규 탐색 커서와 30일 재조회 큐를 분리한다. 과거로 파는 Riot cursor와 같은 표에 넣지 않는다.
- `fco_refresh_queue`는 재시도 상한·backoff와 종결 상태 `gone`을 가진다. 영구 실패가 일일 한도를 계속 태우지 못하게 한다.
- matchtype이 알려 주는 범위까지만 자동 분류한다. 공식경기는 공개 큐 성격, 친선은 우선 `friendly`로 둔다.
  *(개정 2026-09-24: 매치 타입을 행사 맥락의 증거로 쓰지 않는다 — 친선 모드로도 CK·대회를 한다. [FCO-MATCH-CONTEXT-SKILL-PLAN](FCO-MATCH-CONTEXT-SKILL-PLAN.md)이 대체.)*
- Phase 1에서는 FC를 기존 공개 계약에 내보내지 않는다.

완료 조건은 다음과 같다.

- 개발 fixture를 멱등 저장하고 다시 읽을 수 있다.
- FC 한 건이 존재해도 LoL 수집·검수 저장·챔피언 집계가 모두 통과한다.
- LoL 공개 화면과 모듈에는 FC 행이 노출되지 않는다.
- 재조회 불가 경기는 유한 횟수 뒤 `gone`으로 끝난다.

### Phase 1.5 — 맥락 후보 자동 축소

친선전을 곧바로 내전으로 추측하지 않는다. API 정보만으로 아래 신호를 계산해 검토 후보를 줄인다.

- 짧은 시간 안에 등록 스트리머 여러 명이 서로 반복 대결했는가
- 이미 확정된 CK·멸망전 등의 이벤트 시간대와 겹치는가
- 동일 참가자 집합이 연속해서 나타나는가

오탐률을 말하기 전에 정답 표본을 만든다. 이미 확정된 이벤트 표본을 우선 쓰고, 부족하면 후보
10~20건을 사람이 선행 확인한다. 이 표본으로 precision과 누락 사례를 측정한 뒤 Phase 3의 사람 검수량을 정한다.

### Phase 2 — 맥락 검수와 공개 계약

- `event_lead`는 게임 중립으로 유지한다. 한 방송에서 여러 게임을 할 수 있으므로 lead에 단일 `game_code`를 붙이지 않는다.
- 매치 시각과 lead의 실제 VOD 시작 시각을 오차 범위로 교차해 `match_context_candidate`를 만든다.
- 경기당 현재 최종 맥락 판단은 하나로 관리하고, 확인된 VOD·POV 근거는 여러 개를 연결한다.
  VOD 후보/근거 테이블에 `UNIQUE (match_id) WHERE state='accepted'`를 적용하지 않는다.
  *(개정 2026-09-24: 종전의 「수락 후보 하나」를 최종 판단의 유일성과 복수 근거 연결로 분리한다 — [FCO-MATCH-CONTEXT-SKILL-PLAN](FCO-MATCH-CONTEXT-SKILL-PLAN.md)이 대체. 구체적인 제약은 데이터 모델 확정 단계에서 정한다.)*
- 검수 상태는 `unreviewed | reviewed | ambiguous`처럼 사람이 한 판단만 저장한다.
  적용 가능 여부는 `mode_key`, 이벤트 연결 여부는 `event_id IS NOT NULL`에서 파생한다.
- 사람이 바꾼 `event_id`와 맥락 판단은 공급자 재수집이 덮지 않는다.
- 통합 계약은 envelope와 게임별 detail로 만든다. envelope에는 통합 화면이 실제로 쓰는 필드만 둔다.
- `series_key`와 category는 FC 실데이터에서 묶음 의미를 확인하기 전 공통 필드로 확정하지 않는다.
- `versus`는 게임별 필터와 명시적인 통합 보기만 제공한다. 게임별 계산을 암묵적으로 합치지 않는다.
- leaderboard는 `(game_code, mode_key, streamer_id)`를 키로 하고 정렬값과 표시 문자열을 분리한다.

### Phase 3 — VOD 지점 확인과 재평가

- FC VOD는 경기 발견이 아니라 맥락 확인에만 쓴다.
- matchDate에서 계산한 후보 지점의 `±N분`만 확인한다. 방송 중단·재시작 오프셋을 기록한다.
  *(개정 2026-09-24: `±N분`은 도구 초기값이지 판정 규칙이 아니다 — [FCO-MATCH-CONTEXT-SKILL-PLAN](FCO-MATCH-CONTEXT-SKILL-PLAN.md)이 대체.)*
- 기존 CK 도구 중 프레임 추출·근거 기록 부분만 재사용하고 LoL의 전체 탐색 파이프라인을 복제하지 않는다.
- FC 운영 데이터가 충분히 쌓이거나 세 번째 게임을 추가할 때 `game_account` 통합,
  `riot/ → games/lol/` 이동, 공개 계약 재편을 다시 판단한다.

## 4. 컬럼 소유권

공급자 재수집이 갱신할 수 있는 값과 사람이 확정한 값을 분리한다.

| 소유자 | 예시 | 재수집 |
|---|---|---|
| 공급자 | 경기 시각, 점수, matchtype, 원본 상세 | 갱신 가능 |
| 파생 로직 | outcome, 조우, 자동 category 후보 | 원본에서 재계산 |
| 사람 | event 연결, 검수 상태, 맥락 근거 | 자동으로 덮지 않음 |

같은 사실을 상태 문자열과 FK 양쪽에 중복 저장하지 않는다. 특히 `event_linked`는 상태가 아니라
`event_id IS NOT NULL`이 답한다.

## 5. 보류 항목

- 공통 `game_account` 전환
- LoL/FC 참가자 상세 테이블의 전면 분리
- `contract/` 파일 분할
- Riot 디렉터리 이동
- CK 1,000줄대 코드 재편

이들은 FC fixture와 운영 데이터가 두 번째 실제 사례를 보여 준 뒤 비용 대비 효과를 다시 판단한다.
