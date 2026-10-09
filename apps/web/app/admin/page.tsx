import Link from "next/link";
import { adminCounts } from "@soop-lol/core/lib/db/streamers";
import { countOverviewSeries } from "@soop-lol/core/lib/db/match-overview";
import { countUnidentifiedNames } from "@soop-lol/core/lib/db/ck";
import { listFcoSessions } from "@soop-lol/core/lib/games/fconline/sessions";
import { getFcoReviewWorkspace } from "@soop-lol/core/lib/games/fconline/context";
import { listScheduleForAdmin } from "@soop-lol/core/lib/db/schedule";
import { kstDateString } from "@soop-lol/core/lib/time";
import { SetupNotice } from "@/components/admin/SetupNotice";
import { Card } from "@/components/ui";
import { hasRiotKey } from "@/lib/riot";
import { listFcoReviewPriorities } from "@soop-lol/core/lib/db/review-priority";
export const dynamic = "force-dynamic";
export default async function AdminDashboard() {
  try {
    const [counts, lol, unknown, sessions, units, schedule, priorities, generalLol, aram, aramUnknown, generalAram] = await Promise.all([
      adminCounts(), countOverviewSeries({ collection: 'rift', unreviewed: true, queue: 'priority' }), countUnidentifiedNames('', 'rift'),
      listFcoSessions(), getFcoReviewWorkspace({ onlyEvents: true }), listScheduleForAdmin(), listFcoReviewPriorities(),
      countOverviewSeries({ collection: 'rift', unreviewed: true, queue: 'general' }),
      countOverviewSeries({ collection: 'aram', unreviewed: true, queue: 'priority' }), countUnidentifiedNames('', 'aram'),
      countOverviewSeries({ collection: 'aram', unreviewed: true, queue: 'general' }),
    ]);
    const events = units.filter(u => u.kind === "event");
    const fcIds = new Set([...sessions.flatMap(s => s.match_ids), ...events.flatMap(u => u.matches.filter(m => m.decision === 'include').map(m => m.match_id))]);
    const fcValues = [...fcIds].filter(id => (priorities.get(id)?.length ?? 0) > 0).length;
    const generalFc = [...fcIds].filter(id => priorities.has(id) && !priorities.get(id)!.length).length;
    const context = events.filter(u => !u.confirmed).length + sessions.filter(s => s.kind === "meet" && s.context_completed < s.total).length;
    const overdue = schedule.filter(r => ["upcoming", "in_progress"].includes(r.state) && r.period && r.period.to < kstDateString(new Date())).length;
    const tasks = [
      ["협곡 우선 검수", `${lol}시리즈`, "/admin/ck?queue=priority"], ["협곡 참가자 연결", `${unknown}이름`, "/admin/ck/unknown"],
      ["칼바람 우선 검수", `${aram}시리즈`, "/admin/aram?queue=priority"], ["칼바람 참가자 연결", `${aramUnknown}이름`, "/admin/aram/unknown"],
      ["FC 우선 검수", `${fcValues}경기`, "/admin/fco?view=priority"], ["FC 대회·분류 판단", `${context}묶음`, "/admin/fco?view=context"],
      ["계정 후보 연결", `${counts.pending_candidates}계정`, "/admin/candidates"], ["날짜 지난 일정 확인", `${overdue}일정`, "/admin/schedule?overdue=1"],
    ];
    return <div className="grid gap-5"><Card title="검수 대기" description="데이터는 계속 수집·공개됩니다. 확인이 필요한 항목부터 이어서 처리하세요.">
      <ul className="divide-y divide-ink-800">{tasks.map(([label,count,href]) => <li key={href}><Link href={href} className="flex items-center justify-between gap-3 py-4 text-sm hover:text-accent-400"><span>{label}</span><span className="tabular-nums">{count} →</span></Link></li>)}</ul>
    </Card><Card title="시간 있을 때 · 일반 검수" description="우선 검수 조건에 걸리지 않은 미검수 경기입니다. 사람이 확인한 완료 상태와는 다릅니다."><div className="flex flex-wrap gap-5 text-sm"><Link href="/admin/ck?queue=general">협곡 {generalLol}시리즈 →</Link><Link href="/admin/aram?queue=general">칼바람 {generalAram}시리즈 →</Link><Link href="/admin/fco?view=general">FC {generalFc}경기 →</Link></div></Card><details className="rounded border border-ink-800 p-4 text-xs text-ink-400"><summary className="cursor-pointer">수집·설정 현황</summary><div className="mt-3 grid gap-2"><p>스트리머 {counts.streamers}명 · 연결 계정 {counts.accounts}개 · 수집 경기 {counts.matches.toLocaleString()}개</p><p>과거 경기 수집 대기 {counts.backfill_pending}계정 · 티어 기록 {counts.rank_snapshots.toLocaleString()}개</p><p>Riot API 키 {hasRiotKey() ? "설정됨" : "미설정"}</p></div></details></div>;
  } catch (error) { return <SetupNotice error={error} />; }
}
