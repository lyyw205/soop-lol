-- 승패의 표현을 outcome **한 칸**으로 통일한다. boolean 승패는 여기서 은퇴한다.
--
-- 0026 은 outcome 을 win 곁에 **추가**만 했다(전환기). 그 전환기를 여기서 끝낸다 —
-- 같은 사실이 두 칸에 살면 어긋난 순간 어느 쪽이 맞는지 아무도 판단할 수 없고,
-- FC온라인 변환기라는 **새 writer 가 들어오기 전**이 칸을 하나로 줄이는 가장 싼 때다.
-- 칸이 하나면 win=true·outcome='loss' 같은 모순은 CHECK 로 막는 게 아니라
-- **표현 자체가 불가능**해진다.
--
-- ★ "모른다" 는 NULL 이 아니라 'unknown' 이다. NULL 과 'unknown' 이 공존하면
--   그것도 이중 표현이라 outcome 은 NOT NULL 로 조인다.

-- ── 참가자 ──────────────────────────────────────────────────────────

-- 0026 이후 writer 는 둘 다 채워 왔지만, 전환기에 생긴 빈 칸이 있다면 win 에서 이관한다.
UPDATE match_participant SET outcome = CASE WHEN win THEN 'win' ELSE 'loss' END
 WHERE outcome IS NULL AND win IS NOT NULL;

-- 둘 다 비어 판정 불가면 멈춘다. 조용히 'unknown' 을 지어내면 그건 이관이 아니라 날조다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM match_participant WHERE outcome IS NULL) THEN
    RAISE EXCEPTION 'outcome 도 win 도 없는 참가자 행이 있다 — 이관 전에 사람이 정리할 것';
  END IF;
END $$;

ALTER TABLE match_participant ALTER COLUMN outcome SET NOT NULL;
ALTER TABLE match_participant DROP CONSTRAINT match_participant_outcome_check;
ALTER TABLE match_participant ADD CONSTRAINT match_participant_outcome_check
  CHECK (outcome IN ('win','draw','loss','unknown'));

-- ── 조우 ────────────────────────────────────────────────────────────

UPDATE streamer_encounter SET a_outcome = CASE WHEN a_win THEN 'win' ELSE 'loss' END
 WHERE a_outcome IS NULL AND a_win IS NOT NULL;
UPDATE streamer_encounter SET b_outcome = CASE WHEN b_win THEN 'win' ELSE 'loss' END
 WHERE b_outcome IS NULL AND b_win IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM streamer_encounter WHERE a_outcome IS NULL OR b_outcome IS NULL) THEN
    RAISE EXCEPTION 'outcome 도 win 도 없는 조우 행이 있다 — 이관 전에 사람이 정리할 것';
  END IF;
END $$;

ALTER TABLE streamer_encounter ALTER COLUMN a_outcome SET NOT NULL;
ALTER TABLE streamer_encounter ALTER COLUMN b_outcome SET NOT NULL;
ALTER TABLE streamer_encounter DROP CONSTRAINT streamer_encounter_a_outcome_check;
ALTER TABLE streamer_encounter DROP CONSTRAINT streamer_encounter_b_outcome_check;
ALTER TABLE streamer_encounter ADD CONSTRAINT streamer_encounter_a_outcome_check
  CHECK (a_outcome IN ('win','draw','loss','unknown'));
ALTER TABLE streamer_encounter ADD CONSTRAINT streamer_encounter_b_outcome_check
  CHECK (b_outcome IN ('win','draw','loss','unknown'));

-- ── boolean 은퇴 ────────────────────────────────────────────────────
-- 뷰가 컬럼을 물고 있으므로 뷰부터 지우고 아래에서 다시 만든다
-- (그래서 이 두 뷰는 CREATE OR REPLACE 가 아니라 DROP + CREATE 다).

DROP VIEW core_public.match_participant;
DROP VIEW core_public.streamer_encounter;
ALTER TABLE match_participant DROP COLUMN win;
ALTER TABLE streamer_encounter DROP COLUMN a_win;
ALTER TABLE streamer_encounter DROP COLUMN b_win;

-- ⚠ 뷰를 다시 쓸 때 숨김 조인 세 개(경기·계정·사람 visibility)를 함께 유지한다 — 0026 과 동일.

CREATE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         sa.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.outcome,
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

-- 0027 의 모양(시리즈 event COALESCE·best_of 포함)에 승패만 outcome 으로 바뀐다.
CREATE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_outcome, se.b_outcome, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no, se.category, ms.best_of
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';

COMMENT ON COLUMN match_participant.outcome IS
  '승패의 유일한 표현 (win/draw/loss/unknown). boolean win 은 0028 에서 은퇴했다.';
