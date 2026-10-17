/**
 * 편성표 제보 → 편성표 편집 폼의 처음 값. 운영자가 고쳐 저장하는 **제안**일 뿐이다 — 저장 판단은 core saveScheduleEntry 가 한다.
 * ★ 참가자는 이름 글자다. 맞추는 규칙은 core 의 matchStreamerNames 하나(정확히 같은 이름만) — 여기는 폼 값으로 옮기기만 한다.
 */
import { matchStreamerNames, type ScheduleReport } from "@soop-lol/core/lib/metrics/submission";

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
  let unmatched: string[] = [];
  if (report.participants) {
    const matched = matchStreamerNames(report.participants, streamers);
    // 이미 있던 사람은 역할·팀을 그대로 두고, 새 사람은 선수로.
    const keep = new Map(base.participants.map((x) => [x.slug, x]));
    p.participants = matched.slugs.map((slug) => keep.get(slug) ?? { slug, role: "player", team: "" });
    unmatched = matched.unmatched;
  }
  if (evidenceUrl && !p.sources.some((s) => s.url === evidenceUrl)) {
    const filled = p.sources.filter((s) => s.url.trim());
    p.sources = [...filled, { url: evidenceUrl, title: "회원 제보 근거", posted_at: "" }];
  }
  return { payload: p, unmatched, slotsUntouched };
}
