/**
 * 편성표 제보 → 편성표 편집 폼의 처음 값. 운영자가 고쳐 저장하는 **제안**일 뿐이다 — 저장 판단은 core saveScheduleEntry 가 한다.
 * ★ 참가자는 이름 글자다. 등록된 스트리머의 표시 이름·slug 와 정확히 같은 것만 넣고, 나머지는 운영자에게 이름으로 보여 준다.
 */
import type { ScheduleReport } from "@soop-lol/core/lib/metrics/submission";

import type { ScheduleFormPayload } from "@/app/admin/schedule/actions";

export interface ReportPrefill { payload: ScheduleFormPayload; unmatched: string[]; slotsUntouched: boolean }

export function prefillFromReport(base: ScheduleFormPayload, report: ScheduleReport, evidenceUrl: string | null,
  submissionId: string, streamers: { slug: string; display_name: string }[]): ReportPrefill {
  const p: ScheduleFormPayload = { ...base, submission_id: submissionId, slots: [...base.slots], participants: [...base.participants], sources: [...base.sources] };
  if (report.type === "new") { p.planned_format = "unclassified"; p.visibility = "public"; }
  if (report.game_code) p.game_code = report.game_code;
  if (report.title) p.title = report.title;
  if (report.status) p.status = report.status;
  // 방송 칸이 여럿이면 어느 칸인지 모른다 — 운영자가 직접 고친다.
  let slotsUntouched = false;
  if (report.on_date) {
    if (p.slots.length <= 1) {
      const cur = p.slots[0] ?? { label: "", on_date: "", start: "", end: "", channel_id: "" };
      const start = report.start === undefined ? cur.start : report.start ?? "";
      p.slots = [{ ...cur, on_date: report.on_date, start, end: start ? cur.end : "" }];
    } else slotsUntouched = true;
  }
  const unmatched: string[] = [];
  if (report.participants) {
    const byName = new Map<string, string>();
    for (const s of streamers) { byName.set(s.display_name.toLowerCase(), s.slug); byName.set(s.slug.toLowerCase(), s.slug); }
    const keep = new Map(base.participants.map((x) => [x.slug, x]));
    const next: ScheduleFormPayload["participants"] = [];
    for (const name of report.participants.split(",").map((x) => x.trim()).filter(Boolean)) {
      const slug = byName.get(name.toLowerCase());
      if (!slug) { unmatched.push(name); continue; }
      if (!next.some((x) => x.slug === slug)) next.push(keep.get(slug) ?? { slug, role: "player", team: "" });
    }
    p.participants = next;
  }
  if (evidenceUrl && !p.sources.some((s) => s.url === evidenceUrl)) {
    const filled = p.sources.filter((s) => s.url.trim());
    p.sources = [...filled, { url: evidenceUrl, title: "회원 제보 근거", posted_at: "" }];
  }
  return { payload: p, unmatched, slotsUntouched };
}
