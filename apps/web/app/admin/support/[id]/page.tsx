import Link from "next/link";
import { notFound } from "next/navigation";
import { readSessionToken } from "@soop-lol/core/lib/auth/request";
import { getSupportTicket } from "@soop-lol/core/lib/db/support";
import { SupportDetail } from "@/components/support-content";
import { SupportForm } from "@/components/support-forms";
import { requireAdmin } from "@/lib/admin-auth";
export const dynamic = "force-dynamic";
export default async function AdminTicketPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const ticket = await getSupportTicket(await readSessionToken(), (await params).id, true);
  if (!ticket) notFound();
  return <><Link href="/admin/support">← 접수 목록</Link><SupportDetail ticket={ticket} />{!ticket.reply && <section className="support-panel"><h2>답변 작성</h2><SupportForm id={ticket.id} /></section>}</>;
}
