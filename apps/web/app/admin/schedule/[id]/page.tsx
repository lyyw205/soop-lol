import Link from "next/link";
import { notFound } from "next/navigation";

import { getScheduleForAdmin, listEventsForScheduleLink, listScheduleChanges, listStreamerChoices } from "@soop-lol/core/lib/db/schedule";
import { describeChange, kstClock } from "@soop-lol/core/lib/metrics/schedule";
import { kstDateString, toKstInputValue } from "@soop-lol/core/lib/time";

import type { ScheduleFormPayload } from "@/app/admin/schedule/actions";
import { ScheduleDeleteForm, ScheduleForm, type ScheduleEventChoice } from "@/components/admin/ScheduleForm";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "편성표 일정" };

const EMPTY: ScheduleFormPayload = {
  id: null, version: null, typo: false, game_code: "lol", title: "", planned_kind: "ck", sponsor: "", description: "",
  admin_note: "", status: "scheduled", event_id: "", visibility: "public",
  slots: [{ label: "", on_date: "", start: "", end: "", channel_id: "" }],
  participants: [], sources: [{ url: "", title: "", posted_at: "" }],
};

export default async function AdminScheduleEditPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const detail = id === "new" ? null : await getScheduleForAdmin(id);
  if (id !== "new" && !detail) notFound();

  // 저장된 값 → 폼 값. 시각은 KST 벽시계 "HH:MM" 로 보여 준다(서버 로캘과 무관하게).
  const initial: ScheduleFormPayload = detail ? {
    id: detail.id, version: detail.version, typo: false, game_code: detail.input.game_code, title: detail.input.title,
    planned_kind: detail.input.planned_kind, sponsor: detail.input.sponsor ?? "",
    description: detail.input.description ?? "", admin_note: detail.input.admin_note ?? "", status: detail.input.status,
    event_id: detail.input.event_id ?? "", visibility: detail.input.visibility,
    slots: detail.input.slots.map((s) => ({
      label: s.label ?? "", on_date: s.on_date, channel_id: s.channel_id ?? "",
      start: s.starts_at ? kstClock(new Date(s.starts_at)) : "", end: s.ends_at ? kstClock(new Date(s.ends_at)) : "",
    })),
    participants: detail.participants.map((p) => ({ slug: p.slug, role: p.role, team: p.team ?? "" })),
    sources: detail.input.sources.map((s) => ({ url: s.url, title: s.title ?? "", posted_at: s.posted_at ? toKstInputValue(new Date(s.posted_at)).slice(0, 16) : "" })),
  } : EMPTY;

  const changes = detail ? await listScheduleChanges(detail.id) : [];
  const [streamers, lol, fc] = [await listStreamerChoices(), await listEventsForScheduleLink("lol"), await listEventsForScheduleLink("fconline")];
  const choice = (e: { id: string; name: string; kind: string; starts_at: Date | null }): ScheduleEventChoice =>
    ({ id: e.id, name: e.name, kind: e.kind, date: e.starts_at ? kstDateString(new Date(e.starts_at)) : null });

  return (
    <div className="space-y-6">
      <p className="text-sm"><Link href="/admin/schedule" className="text-ink-400 hover:underline">← 편성표</Link></p>
      <Card title={detail ? detail.input.title : "새 일정"} description={saved ? "저장했습니다." : undefined}>
        {/* key: 저장 뒤 새 version 으로 폼 상태를 다시 시작한다 */}
        <ScheduleForm key={detail?.version ?? "new"} initial={initial} streamers={streamers}
          events={{ lol: lol.map(choice), fconline: fc.map(choice) }} />
      </Card>
      {detail && <Card title="변경 이력" description="공개 상세 화면에 그대로 보입니다(오타 수정으로 저장한 것은 남지 않습니다).">
        {changes.length === 0 ? <p className="text-sm text-ink-400">아직 없습니다.</p> : <ul className="space-y-1 text-sm">
          {changes.map((c, i) => <li key={i}><span className="tabular-nums text-ink-400">{kstDateString(new Date(c.changed_at))} {kstClock(new Date(c.changed_at))}</span> · {describeChange(c)}</li>)}
        </ul>}
      </Card>}
      {detail && <Card title="삭제"><ScheduleDeleteForm id={detail.id} version={detail.version} /></Card>}
    </div>
  );
}
