"use server";

import { revalidatePath } from "next/cache";

import { readSessionToken } from "@soop-lol/core/lib/auth/request";
import { MemberError } from "@soop-lol/core/lib/db/member";
import { submitMatchCorrection, submitScheduleReport, supportSubmission } from "@soop-lol/core/lib/db/submission";
import { HOLD_REASON_LABEL } from "@soop-lol/core/lib/metrics/submission";
import { mySubmissionsHref, submitMatchHref, submitScheduleHref } from "@soop-lol/core/lib/site-paths";

import type { ActionState } from "@/lib/action-state";

/**
 * 제보 — 판단(정규화·중복 막기·보류·반영)은 전부 core 의 submission.ts 가 한다. 여기는 폼을 풀어 넘기고 결과 문구만 고른다.
 * ★ 반영되면 공개 화면이 바뀌므로 그 판이 보이는 화면을 다시 그린다(레이아웃 단위).
 */
export async function submitCorrectionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const matchId = String(form.get("match_id") ?? "");
  let payload: unknown;
  try { payload = JSON.parse(String(form.get("payload") ?? "{}")); } catch { return { ok: false, message: "제안 형식이 올바르지 않습니다. 새로고침해 주세요." }; }
  let message: string;
  try {
    const r = await submitMatchCorrection(await readSessionToken(), {
      request_id: String(form.get("request_id") ?? ""), match_id: matchId, payload,
      note: String(form.get("note") ?? ""), evidence_url: String(form.get("evidence_url") ?? ""),
    });
    message = r.kind === "applied" ? "반영했습니다. 운영자가 확인할 때까지 '확인 전'으로 보이고, 전적 합계에는 확인 뒤에 들어갑니다."
      : r.kind === "held" ? `접수했습니다. ${HOLD_REASON_LABEL[r.hold_reason!]}.`
      : r.kind === "supported" ? "같은 내용의 제보가 이미 있어 '같은 내용이에요'로 더했습니다."
      : "이미 접수된 요청입니다.";
  } catch (e) { if (e instanceof MemberError) return { ok: false, message: e.message }; throw e; }
  revalidatePath("/", "layout");
  revalidatePath(submitMatchHref(matchId));
  revalidatePath(mySubmissionsHref());
  return { ok: true, message };
}

/** 편성표 제보 — 언제나 운영자 확인 대기로 받는다(바로 반영하지 않는다). 판단은 core submission.ts. */
export async function submitScheduleReportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const entryId = String(form.get("entry_id") ?? "") || null;
  let payload: unknown;
  try { payload = JSON.parse(String(form.get("payload") ?? "{}")); } catch { return { ok: false, message: "제보 형식이 올바르지 않습니다. 새로고침해 주세요." }; }
  let message: string;
  try {
    const r = await submitScheduleReport(await readSessionToken(), {
      request_id: String(form.get("request_id") ?? ""), entry_id: entryId, payload,
      note: String(form.get("note") ?? ""), evidence_url: String(form.get("evidence_url") ?? ""),
    });
    message = r.kind === "held" ? "접수했습니다. 운영자가 확인한 뒤 편성표에 반영됩니다."
      : r.kind === "supported" ? "같은 내용의 제보가 이미 있어 '같은 내용이에요'로 더했습니다."
      : "이미 접수된 요청입니다.";
  } catch (e) { if (e instanceof MemberError) return { ok: false, message: e.message }; throw e; }
  revalidatePath(submitScheduleHref(entryId));
  revalidatePath(mySubmissionsHref());
  return { ok: true, message };
}

export async function supportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await supportSubmission(await readSessionToken(), String(form.get("id") ?? ""));
  } catch (e) { if (e instanceof MemberError) return { ok: false, message: e.message }; throw e; }
  const entryId = String(form.get("entry_id") ?? "");
  revalidatePath(entryId ? submitScheduleHref(entryId) : submitMatchHref(String(form.get("match_id") ?? "")));
  return { ok: true, message: "같은 내용이에요(+1)를 남겼습니다." };
}
