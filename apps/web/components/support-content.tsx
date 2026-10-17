import Link from "next/link";
import type { SupportTicket } from "@soop-lol/core/lib/db/support";
export const supportDate = (date: Date) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium" }).format(date);
export function SupportList({ rows, page, admin = false }: { rows: Pick<SupportTicket,"id"|"kind"|"title"|"created_at"|"answered_at">[]; page: number; admin?: boolean }) {
  const base = admin ? "/admin/support" : "/support";
  return <section className="support-panel"><h2>{admin ? "접수 목록" : "내 접수 내역"}</h2>
    {!rows.length && <p className="support-muted">접수된 건의·문의가 없습니다.</p>}
    <ul className="support-list">{rows.slice(0,20).map(t => <li key={t.id}><Link href={`${base}/${t.id}`}>
      <small>{t.kind === "suggestion" ? "건의" : "문의"} · {t.answered_at ? "답변 완료" : "답변 대기"} · {supportDate(t.created_at)}</small><span>{t.title}</span>
    </Link></li>)}</ul>
    <nav className="support-paging" aria-label="문의 목록 페이지">{page > 1 && <Link href={`${base}?page=${page-1}`}>이전</Link>}{rows.length > 20 && <Link href={`${base}?page=${page+1}`}>다음</Link>}</nav>
  </section>;
}
export function SupportDetail({ ticket }: { ticket: SupportTicket }) {
  return <><section className="support-panel"><p className="support-muted">{ticket.kind === "suggestion" ? "건의" : "문의"} · {supportDate(ticket.created_at)} · 비공개</p><h1>{ticket.title}</h1><p className="support-body">{ticket.body}</p></section>
    <section className="support-panel"><h2>{ticket.reply ? "운영자 답변" : "답변 대기"}</h2>{ticket.reply ? <><p className="support-body">{ticket.reply}</p><p className="support-muted">{supportDate(ticket.answered_at!)}</p></> : <p className="support-muted">답변이 등록되면 이곳에서 확인할 수 있습니다.</p>}</section></>;
}
