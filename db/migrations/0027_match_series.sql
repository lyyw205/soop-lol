-- 시리즈는 세트(match)에 복제되는 값이 아니라 다전제 하나의 정본이다.
-- 0026 직후라 game_code까지 같이 고정해 서로 다른 게임의 세트가 한 시리즈로 묶이지 않게 한다.

CREATE TABLE match_series (
  id                    text PRIMARY KEY,
  game_code             text NOT NULL CHECK (game_code IN ('lol', 'fconline')),
  event_id              uuid REFERENCES event(id) ON DELETE SET NULL,
  best_of               smallint CHECK (best_of IS NULL OR (best_of > 0 AND best_of % 2 = 1)),
  best_of_evidence      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_series_best_of_has_evidence CHECK (best_of IS NULL OR nullif(btrim(best_of_evidence), '') IS NOT NULL),
  CONSTRAINT match_series_id_game_uq UNIQUE (id, game_code)
);

CREATE INDEX match_series_event_idx ON match_series (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX match_series_game_idx ON match_series (game_code, created_at DESC);
ALTER TABLE match_series ENABLE ROW LEVEL SECURITY;

-- 한 series_id가 이미 여러 게임이나 여러 non-null event에 걸쳤다면 어느 쪽이 정본인지
-- 마이그레이션이 추측하지 않는다. 조용히 합치지 말고 먼저 데이터를 고치게 멈춘다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM match WHERE series_id IS NOT NULL GROUP BY series_id
     HAVING count(DISTINCT game_code) > 1 OR count(DISTINCT event_id) > 1
  ) THEN
    RAISE EXCEPTION 'series_id가 여러 game/event에 걸쳐 있다 — match_series 이관 전에 정리할 것';
  END IF;
END $$;

INSERT INTO match_series (id, game_code, event_id)
SELECT series_id,
       min(game_code),
       (array_agg(event_id) FILTER (WHERE event_id IS NOT NULL))[1]
  FROM match
 WHERE series_id IS NOT NULL
 GROUP BY series_id;

-- 현재 운영 DB의 두 시리즈. series1은 VOD 화면의 `3/2)`가 직접 근거다.
-- series2는 같은 CK의 다음 시리즈이며 26140초 결과 근거가 `시리즈2도 0:2 종료`를 확인한다.
UPDATE match_series
   SET best_of = 3,
       best_of_evidence = CASE id
         WHEN 'ck-2026-09-19-sangho-mansik:series1'
           THEN 'VOD 207602969 14400초 우측 상단 `3/2) 상호팀 0:0 만식팀`'
         WHEN 'ck-2026-09-19-sangho-mansik:series2'
           THEN '같은 CK의 공통 3/2 규칙; VOD 26140초 결과 근거에 `시리즈2도 0:2 종료` 기록'
       END,
       updated_at = now()
 WHERE id IN (
   'ck-2026-09-19-sangho-mansik:series1',
   'ck-2026-09-19-sangho-mansik:series2'
 );

ALTER TABLE match ADD CONSTRAINT match_series_fk
  FOREIGN KEY (series_id, game_code) REFERENCES match_series(id, game_code);

-- series가 있으면 event의 정본은 match_series다. 단판/단일 이벤트 경기만 match.event_id를 쓴다.
UPDATE match SET event_id = NULL WHERE series_id IS NOT NULL;
ALTER TABLE match ADD CONSTRAINT match_series_owns_event
  CHECK (series_id IS NULL OR event_id IS NULL);

COMMENT ON TABLE match_series IS
  '다전제 하나의 정본. game/event/best_of를 세트마다 복제하지 않는다.';
COMMENT ON COLUMN match_series.best_of IS
  '승선승제의 예정 최대 세트 수(Bo1/3/5…). 고정 2세트제·모르는 포맷은 NULL.';
COMMENT ON COLUMN match_series.best_of_evidence IS
  'best_of를 확정한 대회 규정·VOD 시각. 결과 스코어만 보고 추측하지 않는다.';
COMMENT ON COLUMN match.event_id IS
  '단판의 event. series_id가 있으면 NULL이며 match_series.event_id가 정본이다.';

-- 공개 계약은 유효 event를 한 칸으로 내보낸다. 기존 컬럼 순서를 유지하고 best_of만 뒤에 붙인다.
CREATE OR REPLACE VIEW core_public.match AS
  SELECT m.match_id, m.queue_id, m.game_mode, m.game_version, m.game_creation, m.game_duration,
         m.winning_team, m.ended_in_surrender, m.source,
         COALESCE(ms.event_id, m.event_id) AS event_id,
         m.series_id, m.series_game_no, m.blue_team_id, m.red_team_id,
         lol_match_category(m.source, m.queue_id,
           (SELECT kind FROM event WHERE event.id = COALESCE(ms.event_id, m.event_id))) AS category,
         ms.best_of
    FROM match m
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
   WHERE m.visibility = 'public' AND m.game_code = 'lol';

CREATE OR REPLACE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_win, se.b_win, se.a_champion_id, se.b_champion_id,
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
