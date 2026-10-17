-- VOD 판독 요청 — docs/SUBMISSION-POLICY-PLAN.md §6 (2026-10-17)
--
-- ck-auto 의 실행 대기열은 이 PC 의 파일(out/ck/auto/queue.json)이고 배포하면 웹은 서버에서 돈다. 둘을 **이 표 하나**로 잇는다.
--   웹(제보 판정·운영자)  → 한 줄 쓴다(core/lib/db/vod-request.ts requestVodInTx)
--   이 PC(ck:queue plan) → 매시간 열린 요청을 읽어 대기열 **맨 앞**에 넣는다. 감시 목록 밖 채널이어도, 이미 끝난 VOD 여도(다시 연다).
--   이 PC(ck:queue finish·access) → 조사가 끝나면 done, 영상이 없으면 unavailable 로 닫는다.
--
-- ★ 줄은 (VOD, 요청한 제보)마다 하나다. "같은 VOD 는 한 줄로 모은다"는 읽는 쪽(listOpenVodRequests)이 VOD 번호로 묶는다 —
--   그래야 제보마다 "내 VOD 는 지금 어디까지 왔나"(판정의 사실 vod)를 바로 읽는다. 상태는 같은 VOD 의 열린 줄이 함께 움직인다.
-- ★ 상태: queued(요청됨, 이 PC 가 아직 못 봄) → claimed(대기열에 넣음 — 끝난 조사였으면 다시 열었다) → done | unavailable.
--   cancelled = 요청한 쪽이 거둠(제보가 판독 전에 닫혔을 때 — 2단계 ④⑤에서 쓴다).
-- ★ channel_id 는 모를 수 있다(링크에는 VOD 번호만 있다) — 이 PC 가 SOOP 상세에서 채운다.

CREATE TABLE vod_request (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title_no      bigint NOT NULL CHECK (title_no > 0),
  channel_id    text CHECK (channel_id ~ '^[A-Za-z0-9_-]+$'),
  -- 클수록 먼저(metrics/vod-request.ts VOD_REQUEST_PRIORITY). 대기열은 우선순위 → 오래된 순서.
  priority      smallint NOT NULL CHECK (priority BETWEEN 1 AND 1000),
  reason        text NOT NULL CHECK (reason IN ('submission', 'admin')),
  submission_id uuid REFERENCES submission(id) ON DELETE CASCADE,
  note          text CHECK (char_length(note) <= 500),
  requested_by  text NOT NULL,
  state         text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'done', 'unavailable', 'cancelled')),
  -- 닫을 때의 근거(접근 불가 사유 등).
  outcome_note  text CHECK (char_length(outcome_note) <= 500),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  closed_at     timestamptz,
  CHECK ((reason = 'submission') = (submission_id IS NOT NULL)),
  CHECK ((state IN ('queued', 'claimed')) = (closed_at IS NULL))
);
-- 같은 제보가 같은 VOD 를 두 번 요청하지 않는다 · 운영자 요청은 VOD 마다 열린 것 하나.
CREATE UNIQUE INDEX vod_request_submission_uq ON vod_request (title_no, submission_id) WHERE submission_id IS NOT NULL;
CREATE UNIQUE INDEX vod_request_admin_open_uq ON vod_request (title_no) WHERE submission_id IS NULL AND state IN ('queued', 'claimed');
CREATE INDEX vod_request_open_idx ON vod_request (title_no) WHERE state IN ('queued', 'claimed');
CREATE INDEX vod_request_submission_idx ON vod_request (submission_id) WHERE submission_id IS NOT NULL;
ALTER TABLE vod_request ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE vod_request IS 'VOD 판독 요청(웹 → 이 PC 의 ck-auto). 비공개. 쓰기는 core/lib/db/vod-request.ts 만. 줄 = (VOD, 제보), 읽을 때 VOD 로 묶는다.';
