import Link from "next/link";
import { getFcoReviewWorkspace, listFcoCrossClues, type FcoReviewUnit } from "@soop-lol/core/lib/games/fconline/context";
import { listFcoSessions, type FcoSession } from "@soop-lol/core/lib/games/fconline/sessions";
import { kstPlayedAt } from "@soop-lol/core/lib/time";
import { listFcoReviewPriorities } from "@soop-lol/core/lib/db/review-priority";
import { Card, EmptyState } from "@/components/ui";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { adminHref, adminPage } from "@/lib/admin-navigation";

export const metadata = { title: "FC 경기 검수" };
export const dynamic = "force-dynamic";
type Row = { key: string; href: string; title: string; date: string; total: number; done: number; context: string; contextPending: boolean; investigated: boolean; casual: boolean };
const eventRow = (u: FcoReviewUnit): Row => {
  const included = u.matches.filter(m => m.decision === "include");
  return { key: u.id, href: `/admin/fco/event-${u.event!.id}`, title: u.title,
    date: u.matches.at(-1)?.played_at ?? "", total: included.length, done: included.filter(m => m.value_completed).length,
    context: `포함 ${included.length} · 제외 ${u.matches.filter(m => m.decision === "exclude").length} · 미정 ${u.matches.filter(m => !m.decision).length}`,
    contextPending: !u.confirmed, investigated: true, casual: false };
};
const sessionRow = (s: FcoSession): Row => ({ key: s.id, href: `/admin/fco/session/${encodeURIComponent(s.id)}`, title: s.title, date: s.from,
  total: s.total, done: s.completed, context: s.kind === "meet" ? `분류 확정 ${s.context_completed}/${s.total}` : "일반 유저전",
  contextPending: s.kind === "meet" && s.context_completed < s.total, investigated: s.investigated, casual: s.kind !== "meet" });

export default async function FcoReviewListPage({ searchParams }: { searchParams: Promise<{ view?: string; who?: string; vod?: string; q?: string; page?: string }> }) {
  const params = await searchParams;
  const { who = "", vod = "", q = "" } = params;
  const view = ["priority", "general", "pending", "context", "confirmed", "todo", "all", "casual", "clues"].includes(params.view ?? "") ? params.view! : "priority";
  const page = adminPage(params.page), size = 50;
  const [units, sessions, clues, priorities] = await Promise.all([getFcoReviewWorkspace({ onlyEvents: true }), listFcoSessions(), listFcoCrossClues({ who, vod, q }), listFcoReviewPriorities()]);
  const people = [...new Map([...sessions.flatMap(s => s.people), ...units.flatMap(u => u.matches.flatMap(m => m.participants.filter(p => p.slug).map(p => ({ slug: p.slug!, name: p.name }))))].map(p => [p.slug, p.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const rows = [
    ...units.filter(u => u.kind === "event" && (!who || u.matches.some(m => m.participants.some(p => p.slug === who))) && (!vod || u.evidences.some(e => String(e.vod_title_no) === vod))).map(eventRow),
    ...sessions.filter(s => (!who || s.people.some(p => p.slug === who)) && (!vod || s.vods.includes(vod))).map(sessionRow),
  ].map(r => {
    const ids = units.find(u => u.id === r.key)?.matches.filter(m => m.decision === 'include').map(m => m.match_id) ?? sessions.find(s => s.id === r.key)?.match_ids ?? [];
    const urgent = ids.filter(id => (priorities.get(id)?.length ?? 0) > 0);
    const general = ids.filter(id => priorities.has(id) && !priorities.get(id)!.length);
    return { ...r, urgent, general, reasons: [...new Set(urgent.flatMap(id => priorities.get(id)!))] };
  }).filter(r => !q || `${r.title} ${r.key}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.date.localeCompare(a.date));
  const groups: Record<string, typeof rows> = {
    priority: rows.filter(r => r.urgent.length > 0), general: rows.filter(r => r.general.length > 0),
    pending: rows.filter(r => r.done < r.total), context: rows.filter(r => r.contextPending),
    confirmed: rows.filter(r => r.total > 0 && r.done === r.total), todo: rows.filter(r => !r.investigated),
    all: rows, casual: rows.filter(r => r.casual),
  };
  const tabs = [["priority", "우선 검수"], ["general", "일반 검수"], ["pending", "미검수 전체"], ["context", "대회·분류 대기"], ["confirmed", "경기값 완료"], ["todo", "조사 필요"], ["all", "전체"], ["casual", "일반 유저전"], ["clues", "교차 단서"]];
  const tabCount = (key: string) => key === "clues" ? `${clues.length}단서`
    : key === "priority" || key === "general"
      ? `${new Set(groups[key].flatMap(r => key === "priority" ? r.urgent : r.general)).size}경기 · ${groups[key].length}묶음`
      : `${groups[key].length}묶음`;
  const href = adminHref("/admin/fco", { view, who, vod, q, page: String(page) });
  const visible = (groups[view] ?? []).slice((page - 1) * size, page * size);
  const total = view === "clues" ? clues.length : (groups[view]?.length ?? 0);
  return <Card title="FC 경기 검수" description="경기값과 대회·분류 판단을 각각 확인합니다. 대회의 경기값 건수는 포함된 경기만 셉니다.">
    <nav className="mb-4 flex flex-wrap gap-2 text-xs" aria-label="검수 상태">
      {tabs.map(([key, label]) => <Link key={key} href={adminHref(href, { view: key, page: undefined })} aria-current={view === key ? "page" : undefined} className={`rounded border px-2 py-1 ${view === key ? "border-accent-600 text-accent-400" : "border-ink-700 text-ink-400"}`}>{label} {tabCount(key)}</Link>)}
    </nav>
    <form className="mb-3 flex flex-wrap items-center gap-2 text-xs" action="/admin/fco">
      <input type="hidden" name="view" value={view} />
      <input name="q" defaultValue={q} placeholder="대회·대전 이름 검색" aria-label="대회·대전 검색" className="admin-input" />
      <select name="who" defaultValue={who} aria-label="스트리머" className="admin-input"><option value="">모든 스트리머</option>{people.map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}</select>
      <input name="vod" defaultValue={vod} placeholder="VOD 번호" aria-label="VOD 번호" className="admin-input w-28" />
      <button className="admin-input" type="submit">검색</button><Link href={adminHref("/admin/fco", { view })}>초기화</Link>
    </form>
    <AdminPagination href={href} page={page} total={total} size={size} unit={view === "clues" ? "단서" : "묶음"} />
    {!total && <EmptyState>조건에 맞는 항목이 없습니다.</EmptyState>}
    {view === "clues" ? <ul className="divide-y divide-ink-800">{clues.slice((page - 1) * size, page * size).map(c => <li key={`${c.vod_title_no}:${c.at_sec}`} className="min-w-0 py-3 text-sm">
      <div className="flex flex-wrap gap-3"><a href={`https://vod.sooplive.com/player/${c.vod_title_no}?change_second=${c.at_sec ?? 0}`} target="_blank" rel="noreferrer" className="text-accent-400">VOD {c.vod_title_no} · {c.at_sec ?? 0}초 ↗</a>
        <Link href={adminHref("/admin/fco", { view: "all", vod: String(c.vod_title_no) })}>이 방송의 경기 대조 →</Link><span className="text-xs text-ink-400">{c.channel_id} · {kstPlayedAt(new Date(c.observed_at), "datetime")}</span></div>
      <details className="mt-1"><summary className="cursor-pointer break-words text-ink-300">관찰 내용</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs text-ink-400">{c.observed}</p></details>
    </li>)}</ul> : <ul className="divide-y divide-ink-800">{visible.map(r => <li key={r.key} className="flex flex-wrap items-center gap-3 py-3 text-xs">
      <div className="min-w-0 flex-1"><Link href={adminHref(r.href, { from: href, match: view === 'priority' ? r.urgent[0] : view === 'general' ? r.general[0] : undefined })} className="block break-words text-sm text-ink-200 hover:text-accent-400">{r.title}</Link><p className="mt-1 text-ink-400">{kstPlayedAt(new Date(r.date), "datetime")} · {r.context}</p>{view === 'priority' && <p className="mt-1 text-amber-300">{r.reasons.join(' · ')}</p>}</div>
      <span className={r.done === r.total && r.total ? "text-win" : "text-ink-300"}>경기값 {r.done}/{r.total}</span>
      <span className={r.contextPending ? "text-amber-400" : "text-ink-400"}>{r.casual ? "분류 대상 아님" : r.contextPending ? "대회·분류 대기" : "대회·분류 확정"}</span>
    </li>)}</ul>}
    <AdminPagination href={href} page={page} total={total} size={size} unit={view === "clues" ? "단서" : "묶음"} />
  </Card>;
}
