import { AdminBackLink } from "@/components/admin/AdminBackLink";
import { AdminHistory } from "@/components/admin/AdminHistory";
import { notFound } from "next/navigation";

import { getScheduleForAdmin, listEventsForScheduleLink, listScheduleChanges, listStreamerChoices } from "@soop-lol/core/lib/db/schedule";
import { getSubmissionForAdmin } from "@soop-lol/core/lib/db/submission";
import { scheduleReportLines, type ScheduleReport } from "@soop-lol/core/lib/metrics/submission";
import { describeChange, kstClock } from "@soop-lol/core/lib/metrics/schedule";
import { kstDateString, toKstInputValue } from "@soop-lol/core/lib/time";

import type { ScheduleFormPayload } from "@/app/admin/schedule/actions";
import { ScheduleDeleteForm, ScheduleForm, type ScheduleEventChoice } from "@/components/admin/ScheduleForm";
import { Card } from "@/components/ui";
import { prefillFromReport, type ReportPrefill } from "@/lib/schedule-report-prefill";

export const dynamic = "force-dynamic";
export const metadata = { title: "편성표 일정" };

const EMPTY: ScheduleFormPayload = {
  id: null, version: null, typo: false, game_code: "lol", title: "", planned_format: "ck", sponsor: "", description: "",
  admin_note: "", status: "scheduled", event_id: "", visibility: "public",
  slots: [{ label: "", on_date: "", start: "", end: "", channel_id: "" }],
  participants: [], sources: [{ url: "", title: "", posted_at: "" }],
};

export default async function AdminScheduleEditPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; submission?: string }>;
}) {
  const { id } = await params;
  const { saved, submission } = await searchParams;
  const detail = id === "new" ? null : await getScheduleForAdmin(id);
  if (id !== "new" && !detail) notFound();

  // 저장된 값 → 폼 값. 시각은 KST 벽시계 "HH:MM" 로 보여 준다(서버 로캘과 무관하게).
  const initial: ScheduleFormPayload = detail ? {
    id: detail.id, version: detail.version, typo: false, game_code: detail.input.game_code, title: detail.input.title,
    planned_format: detail.input.planned_format, sponsor: detail.input.sponsor ?? "",
    description: detail.input.description ?? "", admin_note: detail.input.admin_note ?? "", status: detail.input.status,
    event_id: detail.input.event_id ?? "", visibility: detail.input.visibility,
    slots: detail.input.slots.map((s) => ({
      label: s.label ?? "", on_date: s.on_date, channel_id: s.channel_id ?? "",
      start: s.starts_at ? kstClock(new Date(s.starts_at)) : "", end: s.ends_at ? kstClock(new Date(s.ends_at)) : "",
    })),
    participants: detail.participants.map((p) => ({ slug: p.slug, role: p.role, team: p.team ?? "" })),
    sources: detail.input.sources.map((s) => ({ url: s.url, title: s.title ?? "", posted_at: s.posted_at ? toKstInputValue(new Date(s.posted_at)).slice(0, 16) : "" })),
  } : EMPTY;

  const [streamers, lol, fc] = [await listStreamerChoices(), await listEventsForScheduleLink("lol"), await listEventsForScheduleLink("fconline")];
  // 회원 편성표 제보 반영 — 그 제보가 이 일정(새 일정이면 new)을 가리키고 아직 열려 있을 때만 미리 채운다.
  const report = submission ? await getSubmissionForAdmin(submission) : null;
  const usable = report && report.kind === "schedule_report" && report.state === "held" && (report.schedule_entry_id ?? "new") === id;
  const prefill: ReportPrefill | null = usable
    ? prefillFromReport(initial, report.payload as ScheduleReport, report.evidence_url, report.id, streamers) : null;

  const changes = detail ? await listScheduleChanges(detail.id) : [];
  const choice = (e: { id: string; name: string; format: ScheduleEventChoice["format"]; starts_at: Date | null }): ScheduleEventChoice =>
    ({ id: e.id, name: e.name, format: e.format, date: e.starts_at ? kstDateString(new Date(e.starts_at)) : null });

  return (
    <div className="space-y-6">
      <p className="text-sm"><AdminBackLink fallback="/admin/schedule">← 편성표</AdminBackLink></p>
      {submission && !usable && <Card title="회원 제보"><p className="text-sm text-amber-400">이 제보는 이미 처리됐거나 이 일정의 제보가 아닙니다. 폼은 지금 일정 값입니다.</p></Card>}
      {prefill && report && <Card title="회원 제보로 미리 채웠습니다" description="확인하고 고친 뒤 저장하면 편성표에 반영되고, 같은 저장에서 제보가 확인 완료로 닫힙니다.">
        <ul className="list-disc pl-5 text-sm text-ink-300">{scheduleReportLines(report.payload as ScheduleReport).map((l) => <li key={l}>{l}</li>)}</ul>
        {report.evidence_url && <p className="mt-2 text-sm">근거: <a href={report.evidence_url} target="_blank" rel="noreferrer noopener" className="text-accent-400 hover:underline">{report.evidence_url}</a></p>}
        {report.note && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-300">메모: {report.note}</p>}
        {prefill.unmatched.length > 0 && <p className="mt-2 text-sm text-amber-400">등록된 스트리머와 이름이 맞지 않아 넣지 않은 참가자: {prefill.unmatched.join(", ")}</p>}
        {prefill.slotsUntouched && <p className="mt-2 text-sm text-amber-400">방송 칸이 여럿이라 날짜·시각은 넣지 않았습니다 — 맞는 칸을 직접 고쳐 주세요.</p>}
      </Card>}
      <Card title={detail ? detail.input.title : "새 일정"} description={saved ? "저장했습니다." : undefined}>
        {/* 같은 일정은 서버가 돌려준 저장 기준값으로 갱신한다. */}
        <ScheduleForm key={`${detail?.id ?? "new"}:${prefill ? report!.id : ""}`} initial={prefill?.payload ?? initial} streamers={streamers}
          events={{ lol: lol.map(choice), fconline: fc.map(choice) }} />
      </Card>
      {detail && <Card title="변경 이력" description="공개 상세 화면에 그대로 보입니다(오타 수정으로 저장한 것은 남지 않습니다).">
        {changes.length === 0 ? <p className="text-sm text-ink-400">아직 없습니다.</p> : <ul className="space-y-1 text-sm">
          {changes.map((c, i) => <li key={i}><span className="tabular-nums text-ink-400">{kstDateString(new Date(c.changed_at))} {kstClock(new Date(c.changed_at))}</span> · {describeChange(c)}</li>)}
        </ul>}
      </Card>}
      {detail && <AdminHistory scope="schedule" id={detail.id} />}
      {detail && <Card title="삭제"><ScheduleDeleteForm id={detail.id} version={detail.version} /></Card>}
    </div>
  );
}
