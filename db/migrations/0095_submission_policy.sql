-- 제보 판정 뼈대 — docs/SUBMISSION-POLICY-PLAN.md (2026-10-17 사용자 결정)
--
-- 판정 기준은 코드(core/lib/metrics/submission-policy.ts)의 규칙 목록 하나다. 이 표는 판정의 **재료와 결과**를 남긴다:
--   intake          접수 순간에 대상에서 본 사실(경기 고치기의 보류 사실). 다시 판정해도 같은 사실로 본다.
--   admin_decision  운영자의 처리(확인·반려) — 사실이다. 상태는 이 사실로 판정한 결과다.
--   rule_id         어느 규칙이 지금 상태를 정했나 · policy_version 그때의 기준 버전 → "어떤 기준으로 검증됐나"
-- state(applied·held·…)는 그대로 둔다 — 판정의 두 축(보임·믿음)을 화면·뷰가 읽는 이름으로 적은 것이다.

ALTER TABLE submission ADD COLUMN intake jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE submission ADD COLUMN admin_decision text CHECK (admin_decision IN ('verify', 'reject'));
ALTER TABLE submission ADD COLUMN rule_id text;
ALTER TABLE submission ADD COLUMN policy_version text;

-- 이미 있는 제보 — 보류 이유를 접수 사실로, 처리된 상태를 운영자 결정으로 옮긴다(운영 DB 는 2026-10-17 기준 0행).
UPDATE submission SET intake = jsonb_build_object(hold_reason, true)
 WHERE hold_reason IS NOT NULL AND hold_reason <> 'schedule_review';
UPDATE submission SET admin_decision = CASE WHEN state = 'verified' THEN 'verify' ELSE 'reject' END
 WHERE state IN ('verified', 'reverted', 'rejected');
UPDATE submission SET rule_id = 'legacy', policy_version = 'legacy';

-- 운영자 결정은 처리 기록과 함께 다닌다(합침=duplicate 는 결정이 아니라 합침이라 없다).
ALTER TABLE submission ADD CONSTRAINT submission_admin_decided CHECK (admin_decision IS NULL OR decided_at IS NOT NULL);

COMMENT ON COLUMN submission.intake IS '접수 순간에 대상에서 본 사실(판정의 재료). 기준(submission-policy.ts)이 바뀌어 다시 판정해도 이 사실로 본다.';
COMMENT ON COLUMN submission.admin_decision IS '운영자의 처리(verify·reject). 사람의 결정은 다시 판정해도 뒤집히지 않는다(규칙 맨 위).';
COMMENT ON COLUMN submission.rule_id IS '지금 상태를 정한 판정 규칙 id(submission-policy.ts). policy_version 과 함께 "어떤 기준으로" 를 남긴다.';
