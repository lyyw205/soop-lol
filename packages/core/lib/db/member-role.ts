/**
 * 계정 권한(0096 member_role) 읽기·쓰기의 단일 출처. docs/SUBMISSION-POLICY-PLAN.md §5
 *
 * ★ 역할은 판정의 사실일 뿐이다 — 이 파일은 "누가 지금 무슨 역할인가"만 안다. 역할이 무엇을 해 주는지는 metrics/submission-policy.ts.
 * ★ 공개 함수(주기·거두기)는 submission.ts 의 grantMemberRole·revokeMemberRole 이다 — 주고 거두면 열린 제보를 다시 판정해야 해서
 *   그쪽이 이 파일의 InTx 쓰기를 부른다(의존은 submission → member-role 한 방향).
 */
import type postgres from "postgres";

import { isMemberRole, type MemberRole } from "../metrics/member-role.ts";
import { db } from "./client.ts";
import { MemberError } from "./member.ts";

type Tx = postgres.TransactionSql;
type Sql = postgres.Sql | Tx;

export interface MemberRoleRow {
  id: number; role: MemberRole; note: string;
  granted_by: string; granted_at: Date; revoked_by: string | null; revoked_at: Date | null;
}

/** 회원들의 지금 유효한 역할. 없는 회원은 빈 목록. */
export async function activeRolesInTx(sql: Sql, memberIds: readonly string[]): Promise<Map<string, MemberRole[]>> {
  const out = new Map<string, MemberRole[]>(memberIds.map((id) => [id, []]));
  if (!memberIds.length) return out;
  const rows = await sql<{ member_id: string; role: MemberRole }[]>`
    SELECT member_id, role FROM member_role WHERE member_id = ANY(${memberIds as string[]}::uuid[]) AND revoked_at IS NULL ORDER BY role`;
  for (const r of rows) out.get(r.member_id)!.push(r.role);
  return out;
}

/** 운영 화면 — 주고 거둔 기록 전부(최근 것 먼저). */
export async function listMemberRoles(memberId: string): Promise<MemberRoleRow[]> {
  return db()<MemberRoleRow[]>`
    SELECT id::int AS id, role, note, granted_by, granted_at, revoked_by, revoked_at
      FROM member_role WHERE member_id = ${memberId}::uuid ORDER BY granted_at DESC, id DESC`;
}

/** 주기 — 회원 행을 잠근 트랜잭션 안에서만. 이미 있으면 거부한다(사유를 덮어쓰지 않는다). */
export async function grantRoleInTx(tx: Tx, memberId: string, role: string, note: string, actor: string, now: Date): Promise<MemberRole> {
  if (!isMemberRole(role)) throw new MemberError("없는 권한입니다.");
  const why = note.trim();
  if (!why) throw new MemberError("권한을 주는 사유를 적어 주세요.");
  if (why.length > 500) throw new MemberError("사유는 500자까지 쓸 수 있습니다.");
  const [had] = await tx`SELECT 1 FROM member_role WHERE member_id = ${memberId}::uuid AND role = ${role} AND revoked_at IS NULL`;
  if (had) throw new MemberError("이미 그 권한이 있습니다.");
  await tx`INSERT INTO member_role (member_id, role, note, granted_by, granted_at) VALUES (${memberId}::uuid, ${role}, ${why}, ${actor}, ${now})`;
  return role;
}

/** 거두기 — 회원 행을 잠근 트랜잭션 안에서만. 없으면 거부한다. */
export async function revokeRoleInTx(tx: Tx, memberId: string, role: string, actor: string, now: Date): Promise<MemberRole> {
  if (!isMemberRole(role)) throw new MemberError("없는 권한입니다.");
  const done = await tx`
    UPDATE member_role SET revoked_by = ${actor}, revoked_at = ${now}
     WHERE member_id = ${memberId}::uuid AND role = ${role} AND revoked_at IS NULL`;
  if (!done.count) throw new MemberError("그 권한이 없습니다.");
  return role;
}
