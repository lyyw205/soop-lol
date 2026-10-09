"use server";
import { reviewMatchData } from "@/lib/ck-review-data";

import { revalidatePath } from "next/cache";

import {
  applyMatchReview,
  createMatchFromEvidence,
  reviewUnidentifiedParticipants,
  setMatchReviewCompleted,
  getMatchDetail,
  ReviewConflictError,
  relinkEvidenceFrame,
  setMatchVisibility,
  streamerIdBySlug,
  type MatchReviewPatch,
} from "@soop-lol/core/lib/db/ck";

import { fromKstInputValue } from "@soop-lol/core/lib/time";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";
import { metaFormValues, META_FORM_FIELDS, PARTICIPANT_FORM_FIELDS, type CkActionState, type CkFormValues } from "@/lib/ck-review-form";
import { sameReviewValue } from "@soop-lol/core/lib/db/review-patch";

function baseValues(form: FormData, fields: readonly string[]): CkFormValues {
  const value: unknown = JSON.parse(text(form, "base"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("편집 기준값이 없습니다. 최신 값을 불러오세요.");
  const record = value as Record<string, unknown>;
  for (const field of fields) if (typeof record[field] !== "string") throw new Error(`${field} 기대값이 없습니다.`);
  return record as CkFormValues;
}
function numberValue(raw: string): number | null {
  if (!raw || raw === "-") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new Error(`0 이상의 정수가 필요합니다: ${raw}`);
  return n;
}
function diffValues(next: Record<string, unknown>, base: Record<string, unknown>) {
  const changes: Record<string, unknown> = {}, expect: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && !sameReviewValue(value, base[key])) { changes[key] = value; expect[key] = base[key]; }
  }
  return { changes, expect };
}
function actionError(error: unknown, latest?: CkFormValues): CkActionState {
  return { ok: false, message: error instanceof Error ? error.message : String(error), latest,
    ...(error instanceof ReviewConflictError ? { conflict: { field: error.field, mine: error.mine, theirs: error.theirs } } : {}) };
}

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function fail(message: string): ActionState {
  return { ok: false, message };
}

/**
 * 저장 후 되돌아봐야 할 곳을 모두 다시 그린다.
 *
 * ★ 공개 화면(`/s/[slug]`)은 `dynamic = "force-dynamic"` 이라 다음 요청에 이미 새 값을
 *   읽는다 — 그래서 여기서 굳이 경로를 안 지정한다. 어드민만 갱신하면 된다.
 */
function revalidateReview(): void {
  revalidatePath("/admin", "layout");
}

// ── 경기 메타 ────────────────────────────────────────────────────────

export async function saveMatchMetaAction(_prev: CkActionState, form: FormData): Promise<CkActionState> {
  await requireAdmin();
  const matchId = text(form, "match_id");
  if (!matchId) return fail("대상 경기가 없습니다.");
  try {
    const base = baseValues(form, META_FORM_FIELDS);
    const normalize = (values: CkFormValues): Record<string, unknown> => ({
      winning_team: values.winning_team ? Number(values.winning_team) : null, event_id: values.event_id || null,
      series_id: values.series_id === "-" ? null : values.series_id || null,
      series_game_no: numberValue(values.series_game_no), game_duration: numberValue(values.game_duration),
      best_of: numberValue(values.best_of),
      best_of_evidence: values.best_of_evidence === "-" ? null : values.best_of_evidence || null,
      game_creation: fromKstInputValue(values.game_creation),
      game_creation_precision: values.game_creation_precision,
      set_order_known: values.set_order_known === "true",
    });
    const submitted = Object.fromEntries(META_FORM_FIELDS.map(k => [k, text(form, k)]));
    // 메타의 빈 텍스트/숫자 입력은 유지, '-'는 비우기. 대회 셀렉트의 빈 값은 연결 해제다.
    for (const k of META_FORM_FIELDS) if (k !== "event_id" && submitted[k] === "") submitted[k] = base[k];
    const next = normalize(submitted);
    if (next.winning_team !== null && ![100,200].includes(Number(next.winning_team))) return fail("승자는 1팀 또는 2팀이어야 합니다.");
    if (!next.game_creation) return fail("경기 시각 형식이 올바르지 않습니다.");
    const patch = diffValues(next, normalize(base));
    const saved = await applyMatchReview(matchId, { match: patch });
    if (!saved) return fail("경기를 찾지 못했습니다.");
    revalidateReview();
    return { ok: true, message: Object.keys(patch.changes).length ? "저장했습니다. 공개 화면에 바로 반영됩니다." : "바뀐 값이 없습니다.", saved: metaFormValues(saved.match) };
  } catch (error) {
    const current = await getMatchDetail(matchId);
    return actionError(error, current ? metaFormValues(current.match) : undefined);
  }
}

/** 로스터 표의 변경 행을 한 트랜잭션으로 저장한다. 개별 행 저장과 같은 충돌 검사를
 * 쓰되, 결과창을 대조하며 여러 명을 고친 뒤 한 번에 확정할 수 있게 한다. */
type RosterRowSubmission = {
  participant_id: number;
  base: CkFormValues | null;
  streamer_slug: string;
  team_id: string;
  team_position: string;
  observed_name: string;
  champion_name: string;
  kills: string;
  deaths: string;
  assists: string;
  clear_puuid?: boolean;
  remove?: boolean;
};

function rosterRows(form: FormData): RosterRowSubmission[] {
  const raw: unknown = JSON.parse(text(form, "roster"));
  if (!Array.isArray(raw)) throw new Error("로스터 입력을 읽을 수 없습니다.");
  return raw.map((row) => {
    if (!row || typeof row !== "object") throw new Error("로스터 행 형식이 올바르지 않습니다.");
    const value = row as Record<string, unknown>;
    const string = (key: string) => typeof value[key] === "string" ? value[key] : "";
    const participantId = Number(value.participant_id);
    if (!Number.isInteger(participantId)) throw new Error("참가자 번호가 올바르지 않습니다.");
    const base = value.base;
    if (base !== null && (!base || typeof base !== "object" || Array.isArray(base))) throw new Error("편집 기준값이 올바르지 않습니다.");
    return {
      participant_id: participantId, base: base as CkFormValues | null,
      streamer_slug: string("streamer_slug"), team_id: string("team_id"), team_position: string("team_position"),
      observed_name: string("observed_name"), champion_name: string("champion_name"),
      kills: string("kills"), deaths: string("deaths"), assists: string("assists"),
      clear_puuid: value.clear_puuid === true, remove: value.remove === true,
    };
  });
}

export async function saveRosterAction(_prev: CkActionState, form: FormData): Promise<CkActionState> {
  await requireAdmin();
  const matchId = text(form, "match_id");
  if (!matchId) return fail("대상 경기가 없습니다.");
  try {
    const rows = rosterRows(form);
    if (new Set(rows.map((row) => row.participant_id)).size !== rows.length) return fail("같은 참가자 번호가 두 번 들어 있습니다.");
    const patch: NonNullable<MatchReviewPatch["participants"]> = { patch: [], add: [], remove: [] };
    for (const row of rows) {
      const teamId = Number(row.team_id);
      if (teamId !== 100 && teamId !== 200) throw new Error("팀은 1팀 또는 2팀이어야 합니다.");
      if (row.base && row.remove) { patch.remove!.push(row.participant_id); continue; }
      if (!row.base) {
        if (row.remove) continue;
        // 완전히 빈 슬롯은 화면상의 자리일 뿐 DB 행이 아니다.
        if (!row.streamer_slug && !row.observed_name) continue;
      }
      const slug = row.streamer_slug.trim();
      const streamerId = slug && slug !== "-" ? await streamerIdBySlug(slug) : null;
      if (slug && slug !== "-" && !streamerId) return fail(`등록된 스트리머가 아닙니다: ${slug}`);
      const puuid = row.clear_puuid ? null : row.base?.puuid || null;
      const observed = row.observed_name.trim() || null;
      if (!streamerId && !puuid && !observed) throw new Error("사람·계정·화면 이름 중 하나는 있어야 합니다.");
      const submitted = {
        streamer_id: streamerId, puuid, observed_name: observed, team_id: teamId,
        team_position: row.team_position.trim() || null, champion_name: row.champion_name.trim() || null,
        kills: numberValue(row.kills.trim()), deaths: numberValue(row.deaths.trim()), assists: numberValue(row.assists.trim()),
      };
      if (!row.base) {
        patch.add!.push({ ...submitted, team_id: teamId as 100 | 200, participant_id: row.participant_id });
        continue;
      }
      const base = row.base;
      for (const key of [...PARTICIPANT_FORM_FIELDS, "streamer_slug"]) {
        if (typeof base[key] !== "string") throw new Error(`${key} 기대값이 없습니다.`);
      }
      const normalizedBase = {
        streamer_id: base.streamer_id || null, puuid: base.puuid || null, observed_name: base.observed_name || null,
        team_id: Number(base.team_id), team_position: base.team_position || null, champion_name: base.champion_name || null,
        kills: numberValue(base.kills), deaths: numberValue(base.deaths), assists: numberValue(base.assists),
      };
      const diff = diffValues(submitted, normalizedBase);
      if ("champion_name" in diff.changes) diff.expect.champion_id = Number(base.champion_id);
      if (Object.keys(diff.changes).length) patch.patch!.push({ participant_id: row.participant_id, ...diff });
    }
    if (!patch.patch!.length) delete patch.patch;
    if (!patch.add!.length) delete patch.add;
    if (!patch.remove!.length) delete patch.remove;
    const changed = Boolean(patch.patch?.length || patch.add?.length || patch.remove?.length);
    const saved = changed ? await applyMatchReview(matchId, { participants: patch }) : await getMatchDetail(matchId);
    if (!saved) return fail("경기를 찾지 못했습니다.");
    if (changed) revalidateReview();
    return { ok: true, message: changed ? "로스터 변경사항을 저장했습니다." : "바뀐 값이 없습니다.", savedRoster: reviewMatchData(saved).participants };
  } catch (error) {
    return actionError(error);
  }
}

// ── 제외 · 복구 ──────────────────────────────────────────────────────

export async function setMatchVisibilityAction(form: FormData): Promise<void> {
  await requireAdmin();
  const matchId = text(form, "match_id");
  const next = text(form, "visibility") === "hidden" ? "hidden" : "public";
  if (!matchId) return;
  await setMatchVisibility(matchId, next);
  revalidateReview();
}

export async function setReviewCompletedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const rawVersion = text(form, "version");
    if (!/^\d+$/.test(rawVersion)) return fail("검수 기준값이 없습니다. 새로고침해 주세요.");
    const completed = text(form, "completed");
    if (!["0", "1"].includes(completed)) return fail("검수 상태가 올바르지 않습니다.");
    await setMatchReviewCompleted(text(form, "match_id"), completed === "1", Number(rawVersion));
    revalidateReview();
    return { ok: true, message: completed === "1" ? "검수를 완료했습니다." : "완료를 취소했습니다." };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ── 프레임 연결 바꾸기 ───────────────────────────────────────────────

export async function createMatchFromFrameAction(
  _prev: ActionState & { matchId?: string; existingMatchId?: string }, form: FormData,
): Promise<ActionState & { matchId?: string; existingMatchId?: string }> {
  await requireAdmin();
  try {
    const day = text(form, "played_on");
    const playedAt = new Date(`${day}T00:00:00+09:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(playedAt.getTime()) ||
      new Date(playedAt.getTime() + 9 * 3600000).toISOString().slice(0, 10) !== day) return fail("경기 날짜를 확인해 주세요.");
    const winner = text(form, "winning_team");
    if (winner && winner !== "100" && winner !== "200") return fail("승리 팀이 올바르지 않습니다.");
    const result = await createMatchFromEvidence({
      frame_id: text(form, "frame_id"), played_at: playedAt,
      series_id: text(form, "series_id") || null, series_game_no: numberValue(text(form, "series_game_no")),
      event_id: text(form, "event_id") || null, winning_team: winner ? Number(winner) as 100 | 200 : null,
    });
    if (result.existing) return { ok: false, message: "이미 등록된 세트입니다. 아래 버튼으로 이 프레임을 연결하세요.", existingMatchId: result.match_id };
    revalidateReview();
    return { ok: true, message: "경기를 만들고 프레임을 연결했습니다. 경기 정보와 로스터를 입력하세요.", matchId: result.match_id };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function relinkFrameAction(form: FormData): Promise<void> {
  await requireAdmin();
  const frameId = text(form, "frame_id");
  const matchId = text(form, "match_id");
  if (!frameId) return;
  await relinkEvidenceFrame(frameId, matchId || null);
  revalidateReview();
}

// ── 미확인 참가자에 사람 붙이기 ──────────────────────────────────────

/** 관리자가 확인한 자리만 검수로 연결한다. 이름으로 대상을 다시 찾지 않는다. */
export async function linkUnknownAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const slug = text(form, "streamer_slug");
    if (!slug) return fail("붙일 사람의 slug 를 넣어 주세요.");
    const streamerId = await streamerIdBySlug(slug);
    if (!streamerId) return fail(`등록된 스트리머가 아닙니다: ${slug}. 먼저 스트리머로 등록해야 붙일 수 있습니다.`);
    const targets = form.getAll("targets").map(value => JSON.parse(String(value)));
    const res = await reviewUnidentifiedParticipants(targets, streamerId);
    if (res.linked === 0) return fail(`연결한 자리가 없습니다. 검수된 경기: ${res.skipped.join(", ") || "없음"}. 목록을 새로 불러오세요.`);
    revalidatePath("/admin", "layout");
    return {ok: true, message: `${res.linked}자리를 연결했습니다 (경기 ${res.matches.length}개).`
      + (res.skipped.length ? ` 검수된 경기 건너뜀: ${res.skipped.join(", ")}` : "")};
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
