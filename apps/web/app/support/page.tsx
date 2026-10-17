import Link from "next/link";
import { currentMember, readSessionToken } from "@soop-lol/core/lib/auth/request";
import { listSupportTickets } from "@soop-lol/core/lib/db/support";
import { SupportForm } from "@/components/support-forms";
import { SupportList } from "@/components/support-content";
export const dynamic = "force-dynamic";
export default async function SupportPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const me = await currentMember();
  const page = Math.max(1, Math.min(10000, Math.trunc(Number((await searchParams).page)) || 1));
  const rows = me ? await listSupportTickets(await readSessionToken(), page) : [];
  return <><h1>건의·문의</h1><p className="support-muted">개선 의견이나 이용 중 불편한 점을 남겨 주세요. 내용과 답변은 본인과 관리자만 볼 수 있습니다.</p>
    <section className="support-panel">{!me ? <p><Link href="/login?next=%2Fsupport">로그인하고 접수하기 →</Link></p> : !me.nickname ? <p><Link href="/me?next=%2Fsupport">가입을 마치고 접수하기 →</Link></p> : <><h2>새로 접수하기</h2><SupportForm /></>}</section>
    {me && <SupportList rows={rows} page={page} />}</>;
}
