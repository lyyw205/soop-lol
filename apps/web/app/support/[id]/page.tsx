import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentMember, readSessionToken } from "@soop-lol/core/lib/auth/request";
import { getSupportTicket } from "@soop-lol/core/lib/db/support";
import { SupportDetail } from "@/components/support-content";
export const dynamic = "force-dynamic";
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!await currentMember()) redirect(`/login?next=${encodeURIComponent(`/support/${id}`)}`);
  const ticket = await getSupportTicket(await readSessionToken(), id);
  if (!ticket) notFound();
  return <><Link href="/support">← 내 접수 내역</Link><SupportDetail ticket={ticket} /></>;
}
