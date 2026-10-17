import type { SessionMember } from "../db/member.ts";

export const basicAdminMode = () => process.env.ADMIN_AUTH_MODE === "basic";
export function isOwnerMember(member: SessionMember | null): boolean {
  return !basicAdminMode() && !!member?.nickname && !!process.env.SUPER_ADMIN_MEMBER_ID
    && member.member_id === process.env.SUPER_ADMIN_MEMBER_ID;
}
