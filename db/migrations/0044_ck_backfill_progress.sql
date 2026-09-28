-- 수동 백필의 목록 위치만 저장한다. VOD별 조사 상태는 event_lead.raw.scan이 정본이다.
CREATE TABLE ck_backfill_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id uuid NOT NULL REFERENCES streamer(id),
  channel_id text NOT NULL UNIQUE,
  upper_before timestamptz NOT NULL,
  cursor_at timestamptz,
  cursor_vod bigint,
  exhausted boolean NOT NULL DEFAULT false,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cursor_at IS NULL) = (cursor_vod IS NULL)),
  CHECK (cursor_at IS NULL OR cursor_at < upper_before),
  CHECK (cursor_vod IS NULL OR cursor_vod > 0)
);
ALTER TABLE ck_backfill_progress ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE ck_backfill_progress IS '사용자 요청으로만 재개하는 SOOP VOD 최신순 백필. 분석 상태는 event_lead에 보존한다.';
CREATE INDEX event_lead_backfill_progress ON event_lead ((raw->'backfill'->>'progress_id'))
  WHERE source = 'vod_title' AND raw ? 'backfill';
