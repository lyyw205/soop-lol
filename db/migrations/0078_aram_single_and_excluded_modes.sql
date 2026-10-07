-- 0078 — 칼바람은 하나로, 아레나·우르프는 집계에서 뺀다 (2026-10-07 운영자 결정).
--
-- ① 증강 칼바람(ARAM: Mayhem, 공개 큐 2400)을 일반 칼바람과 가르지 않는다.
--    0071 의 칼바람 분리는 game_mode='ARAM' 만 봤다. 2400 의 game_mode 가 'ARAM' 이 아니면
--    협곡 쪽 'other' 로 새므로, 공개 큐는 큐 번호로도 칼바람에 넣는다.
-- ② 아레나(CHERRY, 1700/1710/1740/1750)·우르프(URF/ARURF, 900/1900)는 새 분류 'excluded' 다.
--    원본(match·참가자)은 그대로 남기고, 공개 뷰가 협곡·칼바람 어느 쪽에도 내보내지 않는다.
--    지금까지는 'other' 로 "모든 경기"·상대전적·챔피언 통계에 섞여 있었다(아레나 437·우르프 50경기).
--
-- ★ packages/core/lib/metrics/category.ts 의 matchCategory() 와 같은 모양이어야 한다(verify:db 가 전 조합 대조).
-- ★ SET search_path 를 달지 않는다 — 달면 inline 이 막힌다(0075).
-- ★ 3인자 함수는 바꾸지 않는다. 맵·규칙 판정은 4인자에만 있고 쓰는 쪽은 전부 4인자다.
--
-- champion_stat 은 분류가 PK 에 들어 있어 UPDATE 로 옮길 수 없다 — 적용 뒤
-- recomputeChampionStats() 로 다시 만든다(0077 과 같다). 그 전에도 옛 'other' 행에 남은
-- 아레나 판이 보일 뿐 새로 틀리는 값은 없다.

CREATE OR REPLACE FUNCTION lol_match_category(p_source text, p_queue_id integer, p_event_kind text, p_game_mode text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_game_mode = 'ARAM'
      OR (p_source = 'public_queue' AND p_queue_id IN (450, 2400)) THEN
      CASE WHEN p_source = 'public_queue' THEN 'aram' ELSE 'aram_custom' END
    WHEN p_game_mode IN ('CHERRY', 'URF', 'ARURF')
      OR (p_source = 'public_queue' AND p_queue_id IN (1700, 1710, 1740, 1750, 900, 1900)) THEN 'excluded'
    ELSE public.lol_match_category(p_source, p_queue_id, p_event_kind)
  END
$$;

COMMENT ON FUNCTION lol_match_category(text, integer, text, text) IS
  '맵·규칙이 먼저인 경기 분류. 칼바람(일반·증강 구분 없음)=aram/aram_custom, 아레나·우르프=excluded(어느 공개 화면에도 없음). '
  '나머지는 3인자 규칙. packages/core 의 matchCategory() 와 같은 규칙 — verify:db 가 전 조합을 대조한다.';

-- 협곡 공개 뷰는 칼바람과 집계 제외 모드를 함께 뺀다. 칼바람 뷰(aram_*)는 그대로 — 분류 IN 칼바람.
CREATE OR REPLACE VIEW core_public.match AS
 SELECT * FROM core_public.lol_match_all_modes WHERE category NOT IN ('aram', 'aram_custom', 'excluded');
CREATE OR REPLACE VIEW core_public.streamer_encounter AS
 SELECT * FROM core_public.lol_encounter_all_modes WHERE category NOT IN ('aram', 'aram_custom', 'excluded');
CREATE OR REPLACE VIEW core_public.champion_stat AS
 SELECT * FROM core_public.lol_champion_stat_all_modes WHERE category NOT IN ('aram', 'aram_custom', 'excluded');

-- 저장된 조우 분류를 새 함수로 다시 계산한다(뷰와 같은 함수).
UPDATE streamer_encounter se SET category = pm.category
  FROM core_public.lol_match_all_modes pm
 WHERE pm.match_id = se.match_id AND se.category IS DISTINCT FROM pm.category;
