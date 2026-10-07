-- 0077 — 토너먼트 코드 경기를 CK 로 단정하지 않는다: 새 분류 'code_custom'(코드 내전).
--
-- 왜: 코드는 Riot 에 등록한 운영자(내전 사이트·디스코드 봇·대회 도구)가 발급하고 선수가 입력한다.
--     그 판이 CK 인지 시청자 내전·자체 내전·아마추어 대회인지는 API 값으로 알 수 없다.
--     0031 은 "코드 + 대회 없음 = CK" 로 정했고, 그 결과 스트리머 계정의 공개 큐 이력으로 들어온
--     829경기가 90명의 CK 전적·조우 1,622건에 섞였다(2026-10-07). 사람이 검수해 event 를 붙인 판만
--     ck/scrim/tournament 로 올라간다 — 규칙의 나머지는 그대로다.
--
-- ★ packages/core/lib/metrics/category.ts 의 matchCategory() 와 같은 모양이어야 한다(verify:db 가 전 조합 대조).
-- ★ SET search_path 를 달지 않는다 — 달면 inline 이 막힌다(0075).
--
-- 저장된 파생 분류: streamer_encounter.category 는 여기서 다시 계산한다(뷰와 같은 함수).
-- champion_stat 은 분류가 PK 에 들어 있어 UPDATE 로 나눌 수 없다 — 0077 적용 뒤
-- recomputeChampionStats 로 다시 만든다(데이터 복구는 코드 변경과 따로 한다).

CREATE OR REPLACE FUNCTION lol_match_category(
  p_source text, p_queue_id integer, p_event_kind text
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
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
    -- 코드로 만든 커스텀인데 대회가 안 붙었다 → 무슨 판인지 모르는 코드 내전. CK 로 단정하지 않는다.
    WHEN p_source = 'tournament_code'                    THEN 'code_custom'
    -- 수기인데 대회조차 없다. 무슨 판이었는지 근거가 없으므로 지어내지 않는다.
    ELSE 'other'
  END
$$;

COMMENT ON FUNCTION lol_match_category(text, integer, text) IS
  '경기 분류 (solo/flex/aram/normal/clash/ck/code_custom/scrim/tournament/other). '
  'packages/core 의 matchCategory() 와 같은 규칙 — verify:db 가 전 조합을 대조한다. '
  'SET search_path 를 달지 않는다 — 달면 inline 이 막혀 공개 뷰가 행마다 함수를 부른다(0075).';

UPDATE streamer_encounter se SET category = pm.category
  FROM core_public.lol_match_all_modes pm
 WHERE pm.match_id = se.match_id AND se.category IS DISTINCT FROM pm.category;
