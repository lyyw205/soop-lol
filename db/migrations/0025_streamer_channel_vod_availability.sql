-- 0025 — 채널별 VOD 보존 성향은 사람 메모가 아니라 채널의 운영 힌트다.
--
-- 같은 스트리머도 본채널·서브채널의 다시보기 정책이 다를 수 있어 streamer.note에 두면
-- 의미가 어긋난다. 다만 이 값은 영구 규칙도 아니다. 플랫폼 설정과 방송 습관은 바뀌므로
-- `usually_unavailable`이어도 일일 VOD 목록 조회 자체를 생략하는 조건으로 쓰지 않는다.
-- 조사자가 다른 POV를 고를 때 기대 비용을 판단하고, "왜 이 사람 POV를 기다리지 않았나"를
-- 설명하는 힌트로만 쓴다.

ALTER TABLE streamer_channel
  ADD COLUMN vod_availability text NOT NULL DEFAULT 'unknown'
    CHECK (vod_availability IN ('unknown', 'usually_available', 'usually_unavailable')),
  ADD COLUMN vod_availability_checked_at timestamptz;

COMMENT ON COLUMN streamer_channel.vod_availability IS
  'VOD 보존 성향의 운영 힌트. unknown/usually_available/usually_unavailable. 목록 조회를 영구 스킵하는 규칙이 아니다.';
COMMENT ON COLUMN streamer_channel.vod_availability_checked_at IS
  'VOD 보존 성향을 마지막으로 사람이 확인한 시각.';
