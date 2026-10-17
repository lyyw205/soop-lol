/** 비공개 접수: 모든 읽기/쓰기에서 세션과 소유권을 재검사한다. */
import { isOwnerMember } from "../auth/owner.ts";
import { db } from "./client.ts";
import { lockSessionMember, memberFromSession, MemberError } from "./member.ts";
import { isUuid } from "../metrics/community.ts";

export interface SupportTicket {
  id: string; kind: "suggestion" | "inquiry"; title: string; body: string;
  created_at: Date; reply: string | null; answered_at: Date | null;
}
function content(value: string, max: number, label: string) {
  const text = value.trim();
  if (!text || text.length > max) throw new MemberError(`${label}은 1~${max}자로 입력해 주세요.`);
  return text;
}
async function viewer(token: string | null, admin: boolean) {
  const m = await memberFromSession(token);
  if (!m) throw new MemberError("로그인이 필요합니다.");
  if (admin && !isOwnerMember(m)) throw new MemberError("관리자 권한이 없습니다.");
  return m;
}
export async function createSupportTicket(token: string | null, input: { kind: string; title: string; body: string }) {
  return db().begin(async tx => {
    // 제한에 대한 이의 문의도 가능해야 하므로 커뮤니티 제재는 적용하지 않는다.
    const m = await lockSessionMember(tx, token, new Date(), { needNickname: true });
    if (input.kind !== "suggestion" && input.kind !== "inquiry") throw new MemberError("유형을 선택해 주세요.");
    const title = content(input.title, 100, "제목"), body = content(input.body, 5000, "내용");
    const [limit] = await tx`SELECT count(*)::int AS n FROM support_ticket
      WHERE author_id = ${m.id} AND created_at > now() - interval '1 day'`;
    if (limit.n >= 5) throw new MemberError("건의·문의는 하루에 5건까지 접수할 수 있습니다.");
    const [row] = await tx`INSERT INTO support_ticket(author_id,kind,title,body)
      VALUES(${m.id},${input.kind},${title},${body}) RETURNING id`;
    return row.id as string;
  });
}
export async function listSupportTickets(token: string | null, page = 1, admin = false) {
  const m = await viewer(token, admin);
  const offset = (Math.max(1, Math.min(10000, Math.trunc(page) || 1)) - 1) * 20;
  return db()<Pick<SupportTicket, "id" | "kind" | "title" | "created_at" | "answered_at">[]>`
    SELECT id,kind,title,created_at,answered_at FROM support_ticket
    WHERE (${admin} OR author_id = ${m.member_id}) ORDER BY created_at DESC,id LIMIT 21 OFFSET ${offset}`;
}
export async function getSupportTicket(token: string | null, id: string, admin = false): Promise<SupportTicket | null> {
  const m = await viewer(token, admin);
  if (!isUuid(id)) return null;
  const [row] = await db()<SupportTicket[]>`SELECT id,kind,title,body,created_at,reply,answered_at FROM support_ticket
    WHERE id = ${id} AND (${admin} OR author_id = ${m.member_id})`;
  return row ?? null;
}
export async function replySupportTicket(token: string | null, id: string, reply: string) {
  return db().begin(async tx => {
    const m = await lockSessionMember(tx, token, new Date(), { needNickname: true });
    if (!isOwnerMember({ member_id: m.id, nickname: m.nickname, created_at: m.created_at })) throw new MemberError("관리자 권한이 없습니다.");
    if (!isUuid(id)) throw new MemberError("문의를 찾을 수 없습니다.");
    const text = content(reply, 5000, "답변");
    const rows = await tx`UPDATE support_ticket SET reply=${text},answered_by=${m.id},answered_at=now()
      WHERE id=${id} AND reply IS NULL RETURNING id`;
    if (!rows.length) throw new MemberError("이미 답변했거나 삭제된 문의입니다. 새로고침해 주세요.");
  });
}
