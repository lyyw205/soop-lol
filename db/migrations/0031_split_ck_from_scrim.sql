-- CK 와 스크림은 다른 판이다 — 값이 갈리기 전에 갈라 둔다.
--
--   ck    — 승패에 보상이 걸린 스트리머 간 매치. 이 사이트가 다루는 "내전"이 이것이다.
--   scrim — tournament/showmatch 를 준비하며 참가팀끼리 전략을 시험하는 연습게임.
--
-- 지금까지 'scrim' 하나가 CK 의 뜻으로 쓰였다. 현재 DB 의 'scrim' 행은 전부 CK 다
-- (연습게임 데이터는 아직 없다). 그래서 지금 옮긴다 — 스크림 데이터가 쌓인 뒤라면
-- 행마다 어느 쪽인지 다시 조사해야 하는 일이 된다.
--
-- ★ 'scrim' 을 CHECK 에 남기는 이유: 연습게임이라는 뜻으로 곧 쓸 값이다. 같은 문자열의
--   의미가 바뀌므로, 0031 이전 코드·데이터의 'scrim' 은 전부 CK 를 뜻했다고 여기 못박는다.

-- 1) event.kind — 'ck' 추가, 기존 행 이관, 기본값 변경
ALTER TABLE event DROP CONSTRAINT event_kind_check;
UPDATE event SET kind = 'ck' WHERE kind = 'scrim';
ALTER TABLE event ADD CONSTRAINT event_kind_check
  CHECK (kind IN ('ck','scrim','tournament','showmatch','other'));
ALTER TABLE event ALTER COLUMN kind SET DEFAULT 'ck';
COMMENT ON COLUMN event.kind IS
  'ck=승패·보상이 걸린 스트리머 매치(내전), scrim=대회 준비 연습게임, '
  'tournament=공식 대회, showmatch=이벤트전, other=그 외. '
  '0031 이전의 scrim 은 전부 CK 의 뜻이었고 그때 이관했다.';

-- 2) event_lead.kind — 단서 단계도 같은 축을 쓴다
ALTER TABLE event_lead DROP CONSTRAINT event_lead_kind_check;
UPDATE event_lead SET kind = 'ck' WHERE kind = 'scrim';
ALTER TABLE event_lead ADD CONSTRAINT event_lead_kind_check
  CHECK (kind IN ('ck','scrim','tournament','showmatch','other','unknown'));
COMMENT ON COLUMN event_lead.kind IS
  '단서 단계의 분류. ''unknown'' 은 event 로 승격할 수 없다(event.kind CHECK 에 없음) — '
  '검수에서 ck/scrim/tournament/showmatch/other 중 하나로 정한 뒤에만 승격한다.';

-- 3) 분류 함수 — event.kind 를 그대로 따르고, 코드 커스텀의 기본은 CK 다.
--    ★ packages/core 의 matchCategory() 와 같은 모양이어야 한다. verify:db 가 전 조합을 대조한다.
CREATE OR REPLACE FUNCTION lol_match_category(
  p_source text, p_queue_id integer, p_event_kind text
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
-- search_path 고정 이유는 0003·0016 과 같다.
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    -- 대회가 붙어 있으면 그게 가장 확실한 근거다 (사람이 판단해 넣은 값)
    WHEN p_event_kind = 'ck'                             THEN 'ck'
    WHEN p_event_kind = 'scrim'                          THEN 'scrim'
    WHEN p_event_kind IN ('tournament', 'showmatch')     THEN 'tournament'
    WHEN p_source = 'public_queue' THEN CASE p_queue_id
      WHEN 420 THEN 'solo'
      WHEN 440 THEN 'flex'
      WHEN 450 THEN 'aram'
      WHEN 400 THEN 'normal'   -- 일반 드래프트
      WHEN 430 THEN 'normal'   -- 일반 블라인드
      WHEN 490 THEN 'normal'   -- 빠른 대전
      WHEN 700 THEN 'clash'
      -- 모르는 큐를 임의로 '일반' 에 넣지 않는다. other 로 모여 눈에 띄어야 한다.
      ELSE 'other'
    END
    -- 코드로 만든 커스텀인데 대회가 안 붙었다 → 아직 이름을 못 붙인 내전(CK).
    -- 연습 스크림도 코드로 만들 수 있지만, 그건 event 를 붙여 사람이 말해 줘야 안다.
    WHEN p_source = 'tournament_code'                    THEN 'ck'
    -- 수기인데 대회조차 없다. 무슨 판이었는지 근거가 없으므로 지어내지 않는다.
    ELSE 'other'
  END
$$;

COMMENT ON FUNCTION lol_match_category(text, integer, text) IS
  '경기 분류 (solo/flex/aram/normal/clash/ck/scrim/tournament/other). '
  'packages/core 의 matchCategory() 와 같은 규칙 — verify:db 가 전 조합을 대조한다.';

-- 4) 저장된 파생 분류 이관 — 0016 이 속도 때문에 비정규화한 두 컬럼.
--    match 쪽은 뷰가 질의 시점에 계산하므로 함수 교체로 이미 따라온다.
UPDATE streamer_encounter SET category = 'ck' WHERE category = 'scrim';
UPDATE champion_stat      SET category = 'ck' WHERE category = 'scrim';
