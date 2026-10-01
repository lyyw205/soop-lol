"use server";

import { redirect } from "next/navigation";

import {
  deleteScheduleEntry, saveScheduleEntry, ScheduleSaveError, streamerIdsBySlug,
} from "@soop-lol/core/lib/db/schedule";
import { buildSlotTimes, type ScheduleInput } from "@soop-lol/core/lib/metrics/schedule";
import { fromKstInputValue } from "@soop-lol/core/lib/time";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";

/** 폼(ScheduleForm)이 hidden input 하나에 담아 보내는 모양. 검증은 core 의 saveScheduleEntry 가 다시 한다. */
export interface ScheduleFormPayload {
  id: string | null;
  version: string | null;
  game_code: string;
  title: string;
  scale: string;
  planned_kind: string;
  sponsor: string;
  description: string;
  admin_note: string;
  status: string;
  event_id: string;
  visibility: string;
  slots: { label: string; on_date: string; start: string; end: string; channel_id: string }[];
  participants: { slug: string; role: string; team: string }[];
  sources: { url: string; title: string; posted_at: string }[];
}

const blank = (s: string) => (s.trim() ? s.trim() : null);

/**
 * 폼 값 → 저장 입력. 형식 변환만 한다(날짜+시각 → 순간, slug → id).
 * ★ 판단(공개 조건·게임 일치·동시 수정)은 여기서 하지 않는다 — core 접근자 한 곳이 한다.
 */
async function toInput(p: ScheduleFormPayload): Promise<{ input: ScheduleInput } | { errors: string[] }> {
  const errors: string[] = [];
  const slots: ScheduleInput["slots"] = [];
  for (const s of p.slots) {
    const t = buildSlotTimes(s.on_date, s.start.trim(), s.end.trim());
    if (!t.ok) { errors.push(t.error); continue; }
    slots.push({ label: blank(s.label), on_date: s.on_date, starts_at: t.starts_at, ends_at: t.ends_at, channel_id: blank(s.channel_id) });
  }
  const people = p.participants.filter((x) => x.slug.trim());
  const ids = await streamerIdsBySlug(people.map((x) => x.slug.trim()));
  const missing = people.filter((x) => !ids.has(x.slug.trim())).map((x) => x.slug);
  if (missing.length) errors.push(`등록되지 않은 스트리머 slug: ${missing.join(", ")}`);
  const sources: ScheduleInput["sources"] = [];
  for (const s of p.sources.filter((x) => x.url.trim())) {
    const posted = s.posted_at ? fromKstInputValue(s.posted_at) : null;
    if (s.posted_at && !posted) errors.push(`공지 작성 시각이 올바르지 않습니다: ${s.posted_at}`);
    sources.push({ url: s.url.trim(), title: blank(s.title), posted_at: posted });
  }
  if (errors.length) return { errors };
  return {
    input: {
      game_code: p.game_code as ScheduleInput["game_code"], title: p.title, scale: p.scale as ScheduleInput["scale"],
      planned_kind: p.planned_kind as ScheduleInput["planned_kind"], sponsor: blank(p.sponsor), description: blank(p.description),
      admin_note: blank(p.admin_note), status: p.status as ScheduleInput["status"], event_id: blank(p.event_id),
      visibility: p.visibility === "hidden" ? "hidden" : "public", slots,
      participants: people.map((x) => ({ streamer_id: ids.get(x.slug.trim())!, role: x.role as ScheduleInput["participants"][number]["role"], team: blank(x.team) })),
      sources,
    },
  };
}

export async function saveScheduleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  let payload: ScheduleFormPayload;
  try {
    payload = JSON.parse(String(form.get("payload") ?? ""));
  } catch {
    return { ok: false, message: "폼 값을 읽지 못했습니다." };
  }
  const converted = await toInput(payload);
  if ("errors" in converted) return { ok: false, message: converted.errors.join(" / ") };
  let saved: { id: string };
  try {
    saved = await saveScheduleEntry(converted.input, { id: payload.id, version: payload.version });
  } catch (e) {
    if (e instanceof ScheduleSaveError) return { ok: false, message: e.reasons.join(" / ") };
    throw e;
  }
  redirect(`/admin/schedule/${saved.id}?saved=1`);
}

export async function deleteScheduleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    await deleteScheduleEntry(String(form.get("id")), String(form.get("version")));
  } catch (e) {
    if (e instanceof ScheduleSaveError) return { ok: false, message: e.reasons.join(" / ") };
    throw e;
  }
  redirect("/admin/schedule");
}
