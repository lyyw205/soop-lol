-- 멀티게임의 첫 경계. FC온라인 어댑터를 붙이기 전에 LoL 정본과 공개면을 격리한다.
--
-- ★ 이 단계에서는 FC온라인을 공개 계약에 내보내지 않는다. 저장·파생 경로부터 실제
--   응답으로 검증한 뒤 계약을 넓힌다. 그 사이 기존 LoL 화면이 FC 행을 LoL 경기로 읽지
--   못하도록 core_public 뷰에서 game_code='lol' 을 강제한다.

-- ── 경기: 공급자 식별자와 게임 식별자를 분리한다 ────────────────────

ALTER TABLE match RENAME COLUMN game_id TO riot_game_id;

ALTER TABLE match ADD COLUMN game_code text;
UPDATE match SET game_code = 'lol';
ALTER TABLE match ALTER COLUMN game_code SET NOT NULL;
-- 영구 DEFAULT 를 두지 않는다. 새 writer가 game_code를 빼먹으면 FC 경기가 조용히 LoL로
-- 들어가는 것보다 INSERT가 실패하는 편이 안전하다.
ALTER TABLE match ADD CONSTRAINT match_game_code_check
  CHECK (game_code IN ('lol', 'fconline'));

-- 공급자가 부르는 모드 키. LoL은 queue_id 문자열, FC온라인은 matchtype 문자열을 쓴다.
-- 전환 중에는 nullable이다. 각 게임 writer가 명시적으로 채운 뒤 강화한다.
ALTER TABLE match ADD COLUMN mode_key text;
UPDATE match SET mode_key = queue_id::text WHERE queue_id IS NOT NULL;

-- FC온라인에는 Riot queue_id가 없다. 기존 LoL writer와 조회는 그대로 유지한다.
ALTER TABLE match ALTER COLUMN queue_id DROP NOT NULL;

-- source는 "어떻게 알게 됐나"다. 공식/친선 같은 경기 맥락은 mode_key와 event가 정한다.
ALTER TABLE match DROP CONSTRAINT match_source_check;
ALTER TABLE match ADD CONSTRAINT match_source_check
  CHECK (source IN ('public_queue','tournament_code','manual','provider_api'));

CREATE INDEX match_game_created_idx ON match (game_code, game_creation DESC);

-- ── 참가자: 공통 결과와 LoL 전용 값을 겹쳐 쓰지 않는다 ──────────────

ALTER TABLE match_participant ALTER COLUMN champion_id DROP NOT NULL;
ALTER TABLE match_participant ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE match_participant ALTER COLUMN win DROP NOT NULL;

ALTER TABLE match_participant ADD COLUMN side_no smallint;
UPDATE match_participant
   SET side_no = CASE team_id WHEN 100 THEN 1 WHEN 200 THEN 2 END;
ALTER TABLE match_participant ADD CONSTRAINT match_participant_side_no_check
  CHECK (side_no IS NULL OR side_no > 0);

ALTER TABLE match_participant ADD COLUMN outcome text;
UPDATE match_participant SET outcome = CASE WHEN win THEN 'win' ELSE 'loss' END;
ALTER TABLE match_participant ADD CONSTRAINT match_participant_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('win','draw','loss','unknown'));

-- ── 조우: 무승부를 false/false로 합성하지 않는다 ─────────────────────

ALTER TABLE streamer_encounter ALTER COLUMN queue_id DROP NOT NULL;
ALTER TABLE streamer_encounter ALTER COLUMN a_win DROP NOT NULL;
ALTER TABLE streamer_encounter ALTER COLUMN b_win DROP NOT NULL;

ALTER TABLE streamer_encounter ADD COLUMN game_code text;
UPDATE streamer_encounter SET game_code = 'lol';
ALTER TABLE streamer_encounter ALTER COLUMN game_code SET NOT NULL;
ALTER TABLE streamer_encounter ADD CONSTRAINT streamer_encounter_game_code_check
  CHECK (game_code IN ('lol', 'fconline'));

ALTER TABLE streamer_encounter ADD COLUMN mode_key text;
UPDATE streamer_encounter SET mode_key = queue_id::text WHERE queue_id IS NOT NULL;

ALTER TABLE streamer_encounter ADD COLUMN a_outcome text;
ALTER TABLE streamer_encounter ADD COLUMN b_outcome text;
UPDATE streamer_encounter
   SET a_outcome = CASE WHEN a_win THEN 'win' ELSE 'loss' END,
       b_outcome = CASE WHEN b_win THEN 'win' ELSE 'loss' END;
ALTER TABLE streamer_encounter ADD CONSTRAINT streamer_encounter_a_outcome_check
  CHECK (a_outcome IS NULL OR a_outcome IN ('win','draw','loss','unknown'));
ALTER TABLE streamer_encounter ADD CONSTRAINT streamer_encounter_b_outcome_check
  CHECK (b_outcome IS NULL OR b_outcome IN ('win','draw','loss','unknown'));

CREATE INDEX streamer_encounter_game_created_idx
  ON streamer_encounter (game_code, game_creation DESC);

-- ── 공개 경계 ───────────────────────────────────────────────────────
--
-- ⚠ 뷰를 다시 쓸 때 숨김 조인 세 개를 함께 유지한다.
--   · 경기 visibility
--   · 계정 visibility
--   · 사람 visibility
-- 0016에서 이 중 사람 숨김이 한 번 빠졌고, 0020·0021이 다시 막은 자리다.
-- Phase 1에서는 FC 행을 저장할 수만 있고 공개 계약은 LoL만 내보낸다.

CREATE OR REPLACE VIEW core_public.match AS
  SELECT m.match_id, m.queue_id, m.game_mode, m.game_version, m.game_creation, m.game_duration,
         m.winning_team, m.ended_in_surrender, m.source, m.event_id,
         m.series_id, m.series_game_no, m.blue_team_id, m.red_team_id,
         lol_match_category(m.source, m.queue_id,
           (SELECT kind FROM event WHERE event.id = m.event_id)) AS category
    FROM match m
   WHERE m.visibility = 'public' AND m.game_code = 'lol';

CREATE OR REPLACE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         sa.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.win,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges,
         CASE WHEN s.id IS NULL THEN mp.observed_name ELSE NULL END AS observed_name,
         mp.participant_id
    FROM match_participant mp
    JOIN match m ON m.match_id = mp.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    LEFT JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                        AND s.visibility = 'public'
   WHERE s.id IS NOT NULL
      OR (mp.puuid IS NULL AND mp.streamer_id IS NULL AND mp.observed_name IS NOT NULL);

CREATE OR REPLACE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_win, se.b_win, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no, se.category
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';
