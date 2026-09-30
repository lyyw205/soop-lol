-- 감시 목록을 게임별로 나눈다: streamer.watch(예/아니오 한 칸) → streamer_watch(사람 × 게임).
--
-- 한 칸일 때는 FC 중심 스트리머(두치와뿌꾸·임유진)를 넣으면 롤 자동 조사가 FC 방송을 통째로 훑었고,
-- 빼면 FC 쪽에서 "VOD 까지 볼 사람"을 적을 곳이 없었다. 이제 게임마다 따로 적는다.
--   lol      — 롤 자동 조사·단서 수집이 매일 VOD 를 훑는다.
--   fconline — FC VOD 맥락 확인·검수 대상. 넥슨 API 경기만 받는 사람은 여기 넣지 않는다 —
--              그 기준은 FC 계정 연결(streamer_fco_account) 자체라 목록을 두 벌 두지 않는다.
-- 수집 대상이지 중요도 표시가 아니다. 훑은 방송의 참가자는 목록 밖이어도 전부 기록한다.
CREATE TABLE streamer_watch (
  streamer_id uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  game_code   text NOT NULL CHECK (game_code IN ('lol', 'fconline')),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (streamer_id, game_code)
);
CREATE INDEX streamer_watch_game_idx ON streamer_watch (game_code);
ALTER TABLE streamer_watch ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE streamer_watch IS
  '게임별 매일 자동 수집·VOD 검수 대상. 수집 대상이지 중요도 표시가 아니다.';

-- 기존 감시 명단은 전부 롤 몫이었다(watch 를 읽던 곳이 롤 조사뿐이었다).
INSERT INTO streamer_watch (streamer_id, game_code)
SELECT id, 'lol' FROM streamer WHERE watch;

DROP INDEX IF EXISTS streamer_watch_idx;
ALTER TABLE streamer DROP COLUMN watch;
