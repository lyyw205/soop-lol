-- 모듈은 **자기 스키마만** 만든다. core 테이블은 읽기만 하고 건드리지 않는다.
-- 이 모듈을 빼려면: 디렉터리 삭제 + DROP SCHEMA mod_leaderboard CASCADE.
-- core 도, 다른 모듈도 아무 변경이 필요 없다.

CREATE SCHEMA IF NOT EXISTS mod_leaderboard;

-- 파생이다. 언제든 지우고 다시 만들 수 있어야 한다 (docs/PLAN.md §11-5).
CREATE TABLE IF NOT EXISTS mod_leaderboard.standing (
  streamer_id   uuid NOT NULL,
  queue_type    text NOT NULL,
  rank_no       integer NOT NULL,
  puuid         text NOT NULL,
  tier          text,
  division      text,
  league_points integer,
  lp_absolute   integer,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_type, streamer_id)
);

CREATE INDEX IF NOT EXISTS standing_order_idx
  ON mod_leaderboard.standing (queue_type, rank_no);

ALTER TABLE mod_leaderboard.standing ENABLE ROW LEVEL SECURITY;
