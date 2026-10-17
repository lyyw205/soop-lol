-- 제보 반영 방향 바꾸기 — 2026-10-18 사용자 결정
--   경기 고치기: 바로 반영하지 않는다 → **운영자 확인 대기**(correction_review), 운영자가 확인하면 운영자 이름으로 반영. 공개 화면 표시 없음.
--   편성표 제보: 운영자 대기 → **바로 반영** + 공개 편성표에 "확인 전" 표시. 운영자가 확인하면 표시가 떨어지고, 반려하면 제보 전 값으로 되돌린다.
-- 기준은 코드의 규칙 목록 하나(core/lib/metrics/submission-policy.ts) — 이 파일은 그 판정이 쓰는 자리만 만든다.

ALTER TABLE submission DROP CONSTRAINT submission_hold_reason_check;
ALTER TABLE submission ADD CONSTRAINT submission_hold_reason_check
  CHECK (hold_reason IN ('review_completed', 'api_observed', 'account_identity', 'contested', 'not_public', 'schedule_review',
                         'vod_pending', 'vod_not_found', 'vod_unavailable', 'correction_review'));

-- 편성표 제보도 이제 반영됨(applied)·되돌림(reverted)이 있다 — 0094 의 모양 제약에서 그 금지를 뺀다(경기를 가리키지 않는 것은 그대로).
ALTER TABLE submission DROP CONSTRAINT submission_schedule_shape;
ALTER TABLE submission ADD CONSTRAINT submission_schedule_shape CHECK (kind <> 'schedule_report' OR match_id IS NULL);

-- 편성표 제보가 바로 반영된 흔적 — 되돌리기의 원본. 제보 하나에 일정 하나.
--   made    = 제보가 만든 일정(빠진 일정 알리기) — 되돌리기 = 숨기기
--   changed = 제보가 고친 일정 — before 가 고치기 전 저장 입력(ScheduleInput), 되돌리기 = before 로 저장(그 뒤 누가 또 고쳤으면 거부)
--   admin   = 운영자가 편성표 편집으로 반영(보류였던 제보) — 되돌리지 않는다(운영자의 저장이다)
-- after_version = 제보가 저장한 직후의 일정 version — 되돌릴 때 그대로인지 본다.
CREATE TABLE submission_schedule_effect (
  submission_id uuid PRIMARY KEY REFERENCES submission(id) ON DELETE CASCADE,
  entry_id      uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('made', 'changed', 'admin')),
  before        jsonb,
  after_version text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'changed') = (before IS NOT NULL))
);
CREATE INDEX submission_schedule_effect_entry_idx ON submission_schedule_effect (entry_id);
ALTER TABLE submission_schedule_effect ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE submission_schedule_effect IS '편성표 제보가 반영한 흔적(되돌리기 원본). applied 제보의 흔적이 있는 일정 = 확인 전(core_public.pending_schedule).';

-- 확인 전 일정 — 정의는 이 뷰 하나(경기의 core_public.pending_match 와 같은 모양). 공개 편성표 읽기(schedule-public.ts)가 EXISTS 로 본다.
CREATE VIEW core_public.pending_schedule AS
  SELECT DISTINCT e.entry_id AS schedule_id FROM submission_schedule_effect e JOIN submission s ON s.id = e.submission_id
   WHERE s.state = 'applied' AND e.kind <> 'admin';
COMMENT ON VIEW core_public.pending_schedule IS '확인 전 일정(회원 편성표 제보가 바로 반영했고 운영자가 아직 안 본 일정). 공개 편성표가 표시를 단다.';
-- 권한은 공개 일정 뷰(core_public.schedule_entry)의 것을 그대로 받는다(다른 core_public 뷰와 같게 — 0093 과 같은 방식).
DO $$ DECLARE g record;
BEGIN
  FOR g IN SELECT grantee, privilege_type, is_grantable FROM information_schema.table_privileges
            WHERE table_schema = 'core_public' AND table_name = 'schedule_entry' LOOP
    EXECUTE format('GRANT %s ON core_public.pending_schedule TO %s%s', g.privilege_type,
      CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END,
      CASE WHEN g.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
