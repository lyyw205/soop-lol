import { adminHref, adminPage } from "@/lib/admin-navigation";
import { AdminPagination } from "@/components/admin/AdminPagination";
import Link from "next/link";
import { kstDateString } from "@soop-lol/core/lib/time";

import { listScheduleForAdmin } from "@soop-lol/core/lib/db/schedule";
import {
  ENTRY_STATE_LABEL, SCHEDULE_GAME_LABEL, SCHEDULE_KIND_LABEL,
} from "@soop-lol/core/lib/metrics/schedule";

import { SetupNotice } from "@/components/admin/SetupNotice";
import { Card, EmptyState, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "편성표" };

/** 날짜가 지났지만 예정·진행중인 일정을 먼저 점검한다. */
export default async function AdminSchedulePage({ searchParams }: { searchParams: Promise<{ q?: string; game?: string; state?: string; overdue?: string; page?: string }> }) {
  const params = await searchParams;
  const page = adminPage(params.page), size = 50;
  const href = adminHref("/admin/schedule", { ...params, page });
  let rows;
  try {
    rows = await listScheduleForAdmin();
  } catch (e) {
    return <SetupNotice error={e} />;
  }
  const unconfirmed = rows.filter((r) => ((r.state === "upcoming" || r.state === "in_progress") && r.period !== null && r.period.to < kstDateString(new Date()))).length;
  const filtered = rows.filter(r => (!params.q || r.title.toLowerCase().includes(params.q.toLowerCase()))
    && (!params.game || r.game_code === params.game) && (!params.state || r.state === params.state)
    && (params.overdue !== "1" || ((r.state === "upcoming" || r.state === "in_progress") && r.period && r.period.to < kstDateString(new Date()))));
  return (
    <Card
      title={`일정 ${filtered.length}개`}
      description={unconfirmed ? `날짜가 지났지만 상태가 갱신되지 않은 일정 ${unconfirmed}개 — 완료·취소·연기 여부를 확인해 주세요.` : "공지된 대회·CK·이벤트전을 손으로 넣습니다. 공개하려면 근거 공지가 필요합니다."}
      actions={<Link href={adminHref("/admin/schedule/new", { from: href })} className="rounded-lg bg-accent-600 px-3 py-2 text-sm font-medium text-ink-950">새 일정</Link>}
    >
      <form className="mb-3 flex flex-wrap gap-2" action="/admin/schedule">
        <input className="admin-input" name="q" defaultValue={params.q} placeholder="일정 제목 검색" aria-label="일정 검색" />
        <select className="admin-input" name="game" defaultValue={params.game ?? ""} aria-label="게임"><option value="">모든 게임</option>{Object.entries(SCHEDULE_GAME_LABEL).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
        <select className="admin-input" name="state" defaultValue={params.state ?? ""} aria-label="상태"><option value="">모든 상태</option>{Object.entries(ENTRY_STATE_LABEL).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
        <label className="self-center text-xs"><input type="checkbox" name="overdue" value="1" defaultChecked={params.overdue === "1"} /> 날짜 지난 미처리 {unconfirmed}</label>
        <button className="admin-input">검색</button><Link href="/admin/schedule" className="self-center text-xs">초기화</Link>
      </form>
      <AdminPagination href={href} page={page} total={filtered.length} />
      {filtered.length === 0 ? <EmptyState>조건에 맞는 일정이 없습니다.</EmptyState> : (
        <ul className="divide-y divide-ink-800">
          {filtered.slice((page - 1) * size, page * size).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className="w-44 shrink-0 tabular-nums text-ink-400">
                {r.period ? (r.period.from === r.period.to ? r.period.from : `${r.period.from} ~ ${r.period.to.slice(5)}`) : "칸 없음"}
              </span>
              <Link href={adminHref(`/admin/schedule/${r.id}`, { from: href })} className="font-medium hover:underline">{r.title}</Link>
              <Tag>{SCHEDULE_GAME_LABEL[r.game_code]}</Tag>
              <Tag>{SCHEDULE_KIND_LABEL[r.planned_kind]}</Tag>
              <Tag tone={((r.state === "upcoming" || r.state === "in_progress") && r.period !== null && r.period.to < kstDateString(new Date())) ? "warn" : r.state === "held" || r.state === "in_progress" ? "accent" : "neutral"}>{ENTRY_STATE_LABEL[r.state]}</Tag>
              {r.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
              {r.visibility === "public" && r.source_count === 0 && <Tag tone="warn">출처 없음 — 공개 안 됨</Tag>}
              {r.event_id && <Tag tone="accent">결과 연결</Tag>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
