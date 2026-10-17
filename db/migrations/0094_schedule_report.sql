-- 편성표 제보 — docs/USER-SUBMISSION-PLAN.md §12 (2026-10-17 사용자 결정)
--
-- 회원은 편성표를 **제보만** 한다(있는 일정 고치기 · 없는 일정 알리기). 경기 제보와 달리 바로 반영하지 않는다 —
-- 언제나 보류(held, schedule_review)로 접수되고, 운영자가 편성표 편집 폼(제보 내용으로 미리 채운)을 저장할 때
-- 같은 트랜잭션에서 확인 완료가 된다. 쓰기 길은 saveScheduleEntry 하나 그대로다 — 제보만의 편성표 쓰기 SQL 은 없다.
-- 그래서 확인 전 표시·되돌리기·submission_effect 는 편성표에 쓰지 않는다(공개 화면이 바뀌는 건 운영자 저장뿐).

ALTER TABLE submission DROP CONSTRAINT submission_kind_check;
ALTER TABLE submission ADD CONSTRAINT submission_kind_check CHECK (kind IN ('match_correction', 'schedule_report'));

-- 대상 일정. 새 일정 알리기는 접수 때 NULL 이고, 운영자가 반영해 만든 일정을 확인할 때 채운다.
-- 일정이 지워져도 제보 기록은 남는다(SET NULL).
ALTER TABLE submission ADD COLUMN schedule_entry_id uuid REFERENCES schedule_entry(id) ON DELETE SET NULL;
CREATE INDEX submission_schedule_idx ON submission (schedule_entry_id) WHERE schedule_entry_id IS NOT NULL;

ALTER TABLE submission DROP CONSTRAINT submission_hold_reason_check;
ALTER TABLE submission ADD CONSTRAINT submission_hold_reason_check
  CHECK (hold_reason IN ('review_completed', 'api_observed', 'account_identity', 'contested', 'not_public', 'schedule_review'));

-- 종류마다 대상 칸은 하나 — 편성표 제보는 경기를 가리키지 않고, 바로 반영(applied)·되돌림(reverted)이 없다.
ALTER TABLE submission ADD CONSTRAINT submission_schedule_shape CHECK (
  kind <> 'schedule_report' OR (match_id IS NULL AND state NOT IN ('applied', 'reverted')));
ALTER TABLE submission ADD CONSTRAINT submission_match_shape CHECK (kind <> 'match_correction' OR schedule_entry_id IS NULL);

COMMENT ON COLUMN submission.schedule_entry_id IS
  'schedule_report 의 대상 일정. 새 일정 알리기는 운영자가 반영해 만든 일정을 확인할 때 채운다.';
