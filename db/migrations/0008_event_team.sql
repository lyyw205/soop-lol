-- 대회의 '팀' 을 이름 있는 것으로 만든다.
--
-- 지금까지 팀은 `match_participant.team_id` 의 100/200 뿐이었다. 그러면
-- "이 사람이 그 대회에 **어느 팀으로** 나갔나" 를 답할 수 없다 — 경기마다
-- 100/200 은 있지만 그게 '교권보호국' 인지 '고점폭발' 인지가 어디에도 없다.
-- 스트리머별 대회 성적 리스트를 만들려면 팀이 이름을 가져야 한다.
--
-- ★ 팀 소속은 **경기가 아니라 대회 단위**다. 한 대회 안에서 팀은 고정이고
--   경기마다 바뀌지 않는다. 그래서 match 에 팀명을 박지 않고 별도 테이블로 둔다.
--   match 에는 그 경기의 청/홍이 어느 팀이었는지만 가리킨다.

CREATE TABLE event_team (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  name      text NOT NULL,
  UNIQUE (event_id, name),
  -- 아래 event_team_member 의 복합 외래키가 참조한다.
  -- 이게 있어야 '멤버의 event_id 와 팀의 event_id 가 같다' 를 DB 가 강제할 수 있다.
  UNIQUE (id, event_id)
);

COMMENT ON TABLE event_team IS
  '대회에 나온 팀. 같은 이름이라도 대회가 다르면 다른 팀이다 (해마다 팀이 새로 짜인다).';

CREATE TABLE event_team_member (
  -- event_id 를 중복해서 들고 있는 이유는 아래 PK 때문이다.
  -- 한 사람이 한 대회에서 두 팀에 속할 수 없다는 걸 조인 없이 못 박는다.
  event_id      uuid NOT NULL,
  event_team_id uuid NOT NULL,
  streamer_id   uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  -- 주최측이 발표한 로스터 포지션. 그 판의 실제 포지션이 아니다.
  position      text CHECK (position IN ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')),

  PRIMARY KEY (event_id, streamer_id),
  FOREIGN KEY (event_team_id, event_id) REFERENCES event_team (id, event_id) ON DELETE CASCADE
);

ALTER TABLE match ADD COLUMN blue_team_id uuid REFERENCES event_team(id) ON DELETE SET NULL;
ALTER TABLE match ADD COLUMN red_team_id  uuid REFERENCES event_team(id) ON DELETE SET NULL;

COMMENT ON COLUMN match.blue_team_id IS
  'team_id=100 쪽이 어느 팀이었나. 대회 경기에만 있다 (공개 큐에는 팀 개념이 없다).';

CREATE INDEX event_team_event_idx ON event_team (event_id);
CREATE INDEX event_team_member_streamer_idx ON event_team_member (streamer_id);
CREATE INDEX match_blue_team_idx ON match (blue_team_id) WHERE blue_team_id IS NOT NULL;
CREATE INDEX match_red_team_idx  ON match (red_team_id)  WHERE red_team_id  IS NOT NULL;

-- ── core_public ──────────────────────────────────────────────────────
-- 팀 명단도 **공개 스트리머만** 보인다. 숨긴 사람은 팀에서도 사라져야 한다.

CREATE VIEW core_public.event_team AS
  SELECT id AS event_team_id, event_id, name FROM event_team;

CREATE VIEW core_public.event_team_member AS
  SELECT m.event_id, m.event_team_id, m.streamer_id, m.position
    FROM event_team_member m
    JOIN streamer s ON s.id = m.streamer_id AND s.visibility = 'public';

CREATE OR REPLACE VIEW core_public.match AS
  SELECT match_id, queue_id, game_mode, game_version, game_creation, game_duration,
         winning_team, ended_in_surrender, source, event_id,
         series_id, series_game_no,
         blue_team_id, red_team_id
    FROM match;
