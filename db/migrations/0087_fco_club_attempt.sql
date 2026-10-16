-- 2026-10-13 D7: 실패와 미조회를 구분한다. 공개 응답에 오류 원문/계정 ID는 싣지 않는다.
CREATE TABLE fco_club_attempt (
  id bigserial PRIMARY KEY,
  ouid text NOT NULL REFERENCES fco_account(ouid) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  outcome text CHECK (outcome IN ('ok', 'missing', 'error')),
  failure_code text,
  snapshot_id bigint UNIQUE REFERENCES fco_club_snapshot(id) ON DELETE CASCADE,
  legacy boolean NOT NULL DEFAULT false,
  CHECK ((outcome IS NULL) = (completed_at IS NULL)),
  CHECK ((outcome = 'error') = (failure_code IS NOT NULL)),
  CHECK (outcome IS NULL OR (outcome = 'error') = (snapshot_id IS NULL)),
  CHECK (completed_at >= started_at)
);
CREATE INDEX fco_club_attempt_latest ON fco_club_attempt (ouid, started_at DESC, id DESC);
-- 확인할 수 있는 성공/missing만 이관. 기록이 없던 과거 실패는 만들지 않는다.
INSERT INTO fco_club_attempt (ouid, started_at, completed_at, outcome, snapshot_id, legacy)
SELECT ouid, captured_at, captured_at, status, id, true FROM fco_club_snapshot;
-- 내부 수집 장부는 PostgREST 익명/회원에게 노출하지 않는다.
ALTER TABLE fco_club_attempt ENABLE ROW LEVEL SECURITY;
