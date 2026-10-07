-- 0076 — 공개 경기·조우 뷰가 분류(category)를 낼 때 대회 종류를 **행마다 하위 질의로** 찾았다.
-- 값은 바꾸지 않는다. event.id 는 기본키라 LEFT JOIN 이 행을 늘리지 않는다 — 하위 질의와 같은 값이다.
--
-- 실측(2026-10-07, 캐시에 다 올라온 상태): 상대전적 첫 화면의 쌍 집계 1.07초 중 0.83초가
-- 조우 5.5만 행 × event 인덱스 조회였다. 스칼라 하위 질의는 항상 행마다 도는 SubPlan 이 되고,
-- 조인이면 해시 한 번으로 끝난다. 0071 의 정의에서 이 부분만 바꿨다(칸 이름·순서·형은 그대로).

CREATE OR REPLACE VIEW core_public.lol_match_all_modes AS
  SELECT m.match_id, m.queue_id, m.game_mode, m.game_version, m.game_creation, m.game_duration,
         m.winning_team, m.ended_in_surrender, m.source,
         COALESCE(ms.event_id, m.event_id) AS event_id,
         m.series_id, m.series_game_no, m.blue_team_id, m.red_team_id,
         lol_match_category(m.source, m.queue_id, ev.kind, m.game_mode) AS category,
         ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision
    FROM match m
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    LEFT JOIN event ev ON ev.id = COALESCE(ms.event_id, m.event_id)
   WHERE m.visibility = 'public' AND m.game_code = 'lol';

CREATE OR REPLACE VIEW core_public.lol_encounter_all_modes AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_outcome, se.b_outcome, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no, lol_match_category(m.source, m.queue_id, ev.kind, m.game_mode) AS category, ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    LEFT JOIN event ev ON ev.id = COALESCE(ms.event_id, m.event_id)
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';
