-- 다전제(3판 2선승 등)를 세트와 매치 두 단위로 셀 수 있게 한다.
--
-- 왜: 멸망전은 전 경기 다전제다. 2:1 이면 **세트로는 2승 1패, 매치로는 1승 0패**다.
-- 이 둘은 서로 다른 사실이고 섞으면 둘 다 틀린다:
--   - 세트만 세면 "3판 2선승을 2:1 로 이긴 것"과 "단판을 두 번 이기고 한 번 진 것"이 같아진다
--   - 매치만 세면 진 쪽이 따낸 세트가 사라지고, 3:0 과 3:2 가 같아진다
--
-- ★ 매치 승자를 따로 저장하지 않는다. 다전제는 **세트 과반**이 곧 매치 승리라
--   시리즈로 묶어 세기만 하면 유도된다. 따로 저장하면 세트와 어긋날 수 있고,
--   어긋나는 순간 어느 쪽이 맞는지 아무도 판단할 수 없다.
--
-- 단판(공개 큐 솔랭 등)은 series_id 가 NULL 이다. 질의에서
-- COALESCE(series_id, match_id) 로 묶으면 "1매치 = 1세트"가 되어 같은 식이 그대로 통한다.

ALTER TABLE match ADD COLUMN series_id      text;
ALTER TABLE match ADD COLUMN series_game_no smallint;

COMMENT ON COLUMN match.series_id IS
  '같은 다전제에 속한 세트를 묶는 키 (예: meljang-2026-geng:g05). 단판이면 NULL.';
COMMENT ON COLUMN match.series_game_no IS
  '그 다전제 안에서 몇 번째 세트인가 (1부터). 단판이면 NULL.';

-- 둘 중 하나만 채워지면 집계가 조용히 틀어진다. 같이 있거나 같이 없어야 한다.
ALTER TABLE match ADD CONSTRAINT match_series_pair_complete CHECK (
  (series_id IS NULL     AND series_game_no IS NULL) OR
  (series_id IS NOT NULL AND series_game_no IS NOT NULL AND series_game_no >= 1)
);

-- 같은 시리즈에 같은 세트 번호가 둘이면 판수가 부풀어 오른다.
CREATE UNIQUE INDEX match_series_game_uq ON match (series_id, series_game_no)
  WHERE series_id IS NOT NULL;

-- ── core_public 갱신 ─────────────────────────────────────────────────
-- 모듈과 공개 화면도 두 단위를 다 셀 수 있어야 한다.
-- CREATE OR REPLACE VIEW 는 기존 컬럼 순서를 유지하고 뒤에 덧붙일 때만 통한다.

CREATE OR REPLACE VIEW core_public.match AS
  SELECT match_id, queue_id, game_mode, game_version, game_creation, game_duration,
         winning_team, ended_in_surrender, source, event_id,
         series_id, series_game_no
    FROM match;

-- 조우는 세트 단위 행이다. 매치 단위로 세려면 시리즈 키가 필요하므로 여기서 붙여준다.
-- streamer_encounter 테이블 자체에 넣지 않는 이유는, 조우가 match 에서 파생되는
-- 값이라 두 군데에 두면 재파생 때 어긋날 수 있어서다. 원본은 언제나 match 다.
CREATE OR REPLACE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_win, se.b_win, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         -- 단판은 자기 자신이 곧 시리즈다. 이렇게 두면 공개 큐도 같은 식으로 집계된다.
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';
