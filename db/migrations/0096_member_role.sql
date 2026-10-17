-- 계정 권한 — docs/SUBMISSION-POLICY-PLAN.md §5 (2026-10-17 사용자 결정: 표는 만들고 규칙은 꺼 둔 채 시작)
--
-- 역할은 **판정의 사실일 뿐**이다(metrics/submission-policy.ts 의 규칙이 읽는다). 역할마다 화면·코드를 따로 두지 않는다.
-- 역할 목록은 metrics/member-role.ts 의 MEMBER_ROLES 하나 — 이 CHECK 도 같은 목록이다.
-- 주고 거둔 기록은 지우지 않는다(제재 community_sanction 과 같은 모양) — 지금 유효한 것은 revoked_at IS NULL 인 줄 하나.
-- 주거나 거두면 그 회원이 보냈거나 +1 한 열린 제보를 다시 판정한다(core/lib/db/submission.ts grantMemberRole·revokeMemberRole).
-- 운영자(최고 관리자)는 지금처럼 인증 쪽(SUPER_ADMIN_MEMBER_ID)에 남는다 — 여기 역할이 아니다.

CREATE TABLE member_role (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id  uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,   -- 회원 행은 탈퇴해도 남는다(지우는 건 미리보기 샘플뿐)
  role       text NOT NULL CHECK (role IN ('trusted_reporter')),
  note       text NOT NULL CHECK (btrim(note) <> '' AND char_length(note) <= 500),   -- 왜 주었나
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
-- 한 회원에게 같은 역할은 지금 하나만.
CREATE UNIQUE INDEX member_role_active_uq ON member_role (member_id, role) WHERE revoked_at IS NULL;
CREATE INDEX member_role_member_idx ON member_role (member_id, granted_at);
ALTER TABLE member_role ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE member_role IS '계정 권한(판정의 사실). 비공개. 유효 = revoked_at IS NULL. 쓰기는 core/lib/db/submission.ts 의 grantMemberRole·revokeMemberRole 만.';
