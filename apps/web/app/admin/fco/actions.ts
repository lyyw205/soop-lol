"use server";

import { revalidatePath } from "next/cache";

import {
  applyFcoMatchContext, applyFcoMatchContexts, approveFcoContext, approveFcoEvent, holdFcoContext, holdFcoEvent,
  listFcoEventOptions, decideFcoEventMatch, updateFcoEvent,
} from "@soop-lol/core/lib/games/fconline/context";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";

/**
 * CLI(`fco:context apply`)와 같은 반영 함수를 admin 자격으로 부른다.
 * 화면 전용 저장 경로를 만들지 않는다 — 경로가 두 벌이면 보호 규칙이 반드시 어긋난다.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function version(form: FormData) {
  const raw = text(form, "context_version");
  const n = Number(raw);
  if (!raw || !Number.isSafeInteger(n) || n < 0) throw new Error("검수 기준값이 없습니다. 새로고침해 주세요.");
  return n;
}
function versions(form: FormData): Record<string, number> {
  const parsed = JSON.parse(text(form, "context_versions") || "null");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some(v => !Number.isSafeInteger(v) || Number(v) < 0)) throw new Error("검수 기준값이 없습니다. 새로고침해 주세요.");
  return parsed;
}

function fail(error: unknown): ActionState {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

/** 목록과 작업대(행사·경기 어느 쪽이든)를 함께 되살린다 — layout 이면 하위 경로까지 간다. */
function refresh() {
  revalidatePath("/admin/fco", "layout");
}

/** ⏭ 도 실패도 아닌 결과를 사람이 읽을 한 줄로. 성공으로 부풀리지 않는다. */
function summarize(out: { actions: string[]; skipped: string[] }): ActionState {
  if (out.actions.length) return { ok: true, message: out.actions.join(" · ") };
  if (out.skipped.length) return { ok: true, message: `⏭ ${out.skipped.join(" · ")}` };
  return { ok: true, message: "변경 없음" };
}

/**
 * 승인/보류 토글. 되돌릴 수 있어야 사람이 편하게 누른다 —
 * 보류는 확인 도장만 떼고 판단 이력은 건드리지 않는다.
 */
export async function reviewToggleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const eventId = text(form, "event_id");
    const providerMatchId = text(form, "provider_match_id");
    const hold = text(form, "state") === "hold";
    if (eventId) {
      if (hold) {
        const out = await holdFcoEvent(eventId, versions(form));
        refresh();
        return { ok: true, message: out.cleared ? `경기 ${out.cleared}건 보류로 되돌림` : "⏭ 이미 보류다" };
      }
      const out = await approveFcoEvent(eventId, versions(form));
      refresh();
      return { ok: true, message: `포함 ${out.included}건 · 제외 ${out.excluded}건 확정 — 조사 제안 ${out.promoted}건을 사람 결정으로 굳혔다` };
    }
    const out = hold ? await holdFcoContext(providerMatchId, version(form)) : await approveFcoContext(providerMatchId, version(form));
    refresh();
    return summarize(out);
  } catch (error) {
    return fail(error);
  }
}

/**
 * 분류 변경 — 미해결/단순 친선(판단) 과 CK/대회(행사 연결)를 한 창구에서 받는다.
 * 화면은 토글 하나로 보이지만 저장 규칙은 그대로다: 근거 없는 도장은 거부된다.
 */
export async function setClassAction(_prev: ActionState, form: FormData): Promise<ActionState & { nextHref?: string }> {
  await requireAdmin();
  try {
    // 여러 경기에 한 번에(대전 전체) — 선택 전체를 한 트랜잭션으로 저장한다. 하나라도 실패하면 모두 취소한다.
    const ids = [...new Set(form.getAll("provider_match_id").map((v) => String(v).trim()).filter(Boolean))];
    if (!ids.length) throw new Error("경기가 없습니다.");
    const expected = versions(form);
    if (ids.some(id => expected[id] === undefined)) throw new Error("선택한 경기의 기준값이 없습니다. 새로고침해 주세요.");
    const target = text(form, "target");
    if (target === "unresolved" || target === "casual") {
      // 사람이 고를 때 메모는 선택이다. 판단 표(0032)는 빈 메모를 받지 않으므로 "메모 없음"임을 그대로 적는다
      // (지어내지 않는다 — 자동 조사(auto)는 여전히 근거가 필수다. 이 경로는 admin 뿐이다).
      const note = text(form, "note") || "검수자 판단(메모 없음)";
      const out = await applyFcoMatchContexts(ids.map(id => ({ provider_match_id: id, expectedVersion: expected[id], conclusion: target, note })));
      refresh();
      return summarize(out);
    }
    // 행사 계열 — 기존 행사를 고르거나(event_id) 새로 만든다.
    const kind = target;
    if (!["ck", "scrim", "tournament", "showmatch", "other"].includes(kind)) {
      throw new Error(`알 수 없는 분류다: ${target}`);
    }
    const pickedId = text(form, "existing_event_id");
    let meta: { slug: string; name: string; kind: string; organizer: string | null; source_url: string };
    if (pickedId) {
      const options = await listFcoEventOptions();
      const found = options.find((o) => o.id === pickedId);
      if (!found) throw new Error("고른 행사를 찾을 수 없다");
      if (!found.slug) throw new Error("slug 없는 행사에는 연결할 수 없다");
      if (!found.source_url) throw new Error("확인 근거 URL 이 없는 행사다 — 먼저 행사에 근거를 채운다");
      meta = { slug: found.slug, name: found.name, kind: found.kind, organizer: found.organizer, source_url: found.source_url };
    } else {
      meta = {
        slug: text(form, "slug"), name: text(form, "name"), kind,
        organizer: text(form, "organizer") || null, source_url: text(form, "source_url"),
      };
      if (!meta.slug || !meta.name) throw new Error("새 행사에는 slug 와 이름이 필요하다");
    }
    const series = text(form, "series_id")
      ? { id: text(form, "series_id"), game_no: Number(text(form, "series_game_no") || "1") }
      : undefined;
    if (series && ids.length > 1) throw new Error("세트 번호는 경기별로 지정해 주세요.");
    const out = await applyFcoMatchContexts(ids.map(id => ({
      provider_match_id: id, expectedVersion: expected[id], conclusion: "event" as const,
      event: meta as NonNullable<Parameters<typeof applyFcoMatchContext>[0]["event"]>, ...(series ? { series } : {}),
    })), { relink: true });
    const destination = await listFcoEventOptions().then(events => events.find(event => event.slug === meta.slug)).catch(() => undefined);
    revalidatePath("/admin/fco");
    return { ...summarize(out), nextHref: destination ? `/admin/fco/event-${destination.id}` : "/admin/fco" };
  } catch (error) {
    return fail(error);
  }
}

export async function addEvidenceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const providerMatchId = text(form, "provider_match_id");
    const kind = text(form, "kind");
    const vod = text(form, "vod_title_no");
    const at = text(form, "at_sec");
    const url = text(form, "url");
    if (!["vod_frame", "chat", "audio", "notice", "url"].includes(kind)) throw new Error("근거 종류가 올바르지 않다");
    const vodNo = vod ? Number(vod) : null;
    const atSec = at ? Number(at) : null;
    if (vod && (!Number.isInteger(vodNo) || vodNo! <= 0)) throw new Error("VOD 번호는 양의 정수다");
    if (at && (!Number.isInteger(atSec) || atSec! < 0)) throw new Error("전체 초는 0 이상의 정수다");
    // 멱등 키는 CLI 와 같은 관례로 만든다 — 같은 근거를 화면과 CLI 로 두 번 넣어도 한 행이다.
    const key = text(form, "evidence_key")
      || (kind === "vod_frame" && vodNo != null ? `vod:${vodNo}@${atSec ?? 0}` : "")
      || ((kind === "url" || kind === "notice") && url ? `${kind}:${url}` : "")
      || ((kind === "chat" || kind === "audio") && vodNo != null && atSec != null ? `${kind}:${vodNo}@${atSec}` : "");
    if (!key) throw new Error("화면·채팅·음성은 VOD 번호와 전체 초를, 공지·외부 링크는 URL을 입력해 주세요.");
    const out = await applyFcoMatchContext(
      {
        provider_match_id: providerMatchId, expectedVersion: version(form),
        evidences: [{
          evidence_key: key,
          kind: kind as "vod_frame" | "chat" | "audio" | "notice" | "url",
          vod_title_no: vodNo,
          channel_id: text(form, "channel_id") || null,
          at_sec: atSec,
          url: url || null,
          observed: text(form, "observed"),
          why: text(form, "why") || null,
        }],
      },
      { createdBy: "admin" },
    );
    refresh();
    return summarize(out);
  } catch (error) {
    return fail(error);
  }
}

/** [경기] 탭 — 이 경기를 대회에 넣거나 빼고, 브래킷 위치를 정한다. 저장하면 곧바로 공개 연결에 반영된다. */
export async function decideMatchAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const decision = text(form, "decision");
    if (decision !== "include" && decision !== "exclude") throw new Error("포함 또는 제외를 고른다");
    const no = text(form, "bracket_no");
    const out = await decideFcoEventMatch({
      eventId: text(form, "event_id"),
      providerMatchId: text(form, "provider_match_id"),
      decision, expectedVersion: version(form),
      bracketNo: no ? Number(no) : null,
      bracketLabel: text(form, "bracket_label") || null,
      note: text(form, "note") || null,
    }, { createdBy: "admin" });
    refresh();
    return summarize(out);
  } catch (error) {
    return fail(error);
  }
}

/** [대회] 탭 — 행사 정보 수정. */
export async function updateEventAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    await updateFcoEvent(text(form, "event_id"), {
      expectedVersion: version(form), name: text(form, "name"),
      kind: text(form, "kind") || undefined,
      organizer: text(form, "organizer"),
      source_url: text(form, "source_url"),
    });
    refresh();
    return { ok: true, message: "행사 정보 저장" };
  } catch (error) {
    return fail(error);
  }
}
