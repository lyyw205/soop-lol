import { readSessionToken } from "@soop-lol/core/lib/auth/request";
import { listSupportTickets } from "@soop-lol/core/lib/db/support";
import { SupportList } from "@/components/support-content";
import { requireAdmin } from "@/lib/admin-auth";
export const dynamic = "force-dynamic";
export default async function AdminSupportPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireAdmin();
  const page = Math.max(1, Math.min(10000, Math.trunc(Number((await searchParams).page)) || 1));
  const rows = await listSupportTickets(await readSessionToken(), page, true);
  return <><h1>건의·문의 관리</h1><p className="support-muted">작성자에게만 공개되는 답변을 등록합니다.</p><SupportList rows={rows} page={page} admin /></>;
}
