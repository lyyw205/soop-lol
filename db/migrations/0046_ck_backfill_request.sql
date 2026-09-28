-- 수동 백필 재설계: 진척 기록을 VOD 조사 도장(event_lead.raw) 하나로 줄인다.
--
-- 0044 는 채널마다 고정 상한·커서·소진 여부를 따로 저장하고, VOD 에 백필 표시(raw.backfill)를 달았다.
-- 그 두 번째 진척 기록이 VOD 도장과 어긋나 이미 끝낸 VOD 를 다시 조사했다.
-- 이제 백필은 요청 기간의 목록을 매번 다시 받아 도장이 완료가 아닌 VOD 만 조사한다.
-- 남기는 건 "마지막으로 요청한 기간" 하나뿐이다 — 진척이 아니라 다음 요청의 기본값이다.
DROP INDEX IF EXISTS event_lead_backfill_progress;
DROP TABLE ck_backfill_progress;

CREATE TABLE ck_backfill_request (
  channel_id   text PRIMARY KEY,
  streamer_id  uuid NOT NULL REFERENCES streamer(id),
  from_date    date NOT NULL,
  to_date      date NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_date <= to_date)
);
ALTER TABLE ck_backfill_request ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE ck_backfill_request IS
  '채널별 마지막 백필 요청 기간(KST, VOD 종료일 기준). 진척 기록이 아니다 — 진척은 event_lead.raw.scan 이 정본.';

-- 백필 표시는 버리고, 접근 상태는 자동·수동 공용 키(raw.access)로 옮긴다. 사유·확인 시각은 보존한다.
UPDATE event_lead
   SET raw = (raw - 'backfill' - 'backfill_access')
             || CASE WHEN raw ? 'backfill_access' THEN jsonb_build_object('access', raw->'backfill_access') ELSE '{}'::jsonb END
 WHERE source = 'vod_title' AND (raw ? 'backfill' OR raw ? 'backfill_access');
