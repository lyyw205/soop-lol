/**
 * 계정 권한(역할) 목록 — 단일 출처. DB CHECK(0096 member_role.role)도 같은 목록이다.
 * 역할은 판정의 사실일 뿐이다 — 무엇을 해 주는지는 metrics/submission-policy.ts 의 규칙이 정한다(docs/SUBMISSION-POLICY-PLAN.md §5).
 */
export const MEMBER_ROLES = ["trusted_reporter"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  trusted_reporter: "신뢰 제보자",
};

export const isMemberRole = (x: unknown): x is MemberRole => (MEMBER_ROLES as readonly unknown[]).includes(x);
