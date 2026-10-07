-- 0080 — 랜드의 series_key 를 다시 랜드 묶음으로 돌린다. 판 단위로 세는 것은 집계 쪽 규칙이다.
--
-- 0079 는 "랜드는 판마다 매치 하나" 를 지키려고 공개 조우 뷰의 series_key 를 판 자신으로 내보냈다.
-- 그런데 series_key 는 **화면이 한 줄로 접는 단위**이기도 해서, 상대전적 화면에서 랜드 한 번이
-- 판마다 한 줄씩(8판이면 8줄, 전부 '단판')으로 흩어졌다(운영자 지적, 2026-10-07).
-- 개인 히스토리는 series_id 로 접어 한 줄로 나왔으니 화면끼리도 말이 달랐다.
--
-- 묶는 단위와 세는 단위를 한 칸에 겹치지 않는다:
--   · series_key = 묶음(시리즈·랜드 한 번). 화면은 이것으로 한 줄을 만든다.
--   · 매치 수 = packages/core/lib/metrics/match-tally.ts 의 tallyGroup 하나 — 랜드 묶음은 판 수만큼,
--     나머지는 과반으로 1. SQL 집계(listOpponents, listPersonalRecords)도 같은 규칙으로 센다.
-- 0079 의 정의에서 series_key 줄만 되돌렸다(칸 이름·순서·형은 그대로).

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
         m.game_creation_precision,
         m.set_role
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    LEFT JOIN event ev ON ev.id = COALESCE(ms.event_id, m.event_id)
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';
