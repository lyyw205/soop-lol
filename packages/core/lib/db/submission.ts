/**
 * **사용자 제보의 단일 출처** — 접수·중복 막기·보류 판정·반영·확인·반려(되돌리기)·목록. docs/USER-SUBMISSION-PLAN.md (0093).
 *
 *   회원(쿠키 토큰을 계약·화면이 넘긴다)  submitMatchCorrection · submitScheduleReport · supportSubmission · listMySubmissions · getMySubmission
 *                                          · listOpenSubmissions
 *   운영자(requireAdmin 뒤, actor 글자)    listSubmissionQueue · getSubmissionForAdmin · verifySubmission · rejectSubmission · markSubmissionDuplicate
 *                                          · applyScheduleReport(편성표 저장 + 제보 닫기를 한 트랜잭션에서)
 *
 * ★ **판정 기준은 여기 없다** — metrics/submission-policy.ts 의 규칙 목록 하나(docs/SUBMISSION-POLICY-PLAN.md).
 *   여기는 ① 사실 모으기(접수 사실 intake · 운영자 결정) → decide → ③ 실행(settleInTx: 보임이 바뀌면 종류별 어댑터의 show/hide)만 한다.
 *   접수·운영자 확인·반려·편성표 반영은 모두 "사실을 남기고 판정한다" 한 길로 끝난다. 새 기준 때문에 여기에 if 가 생기면 뼈대가 틀어진 것이다.
 * ★ 판정이 보는 사실은 factsInTx 하나가 모은다 — 접수 사실(intake)·운영자 결정·보낸 사람의 역할·같은 내용 회원 수.
 *   사실이 바뀌는 곳(+1·권한 주기/거두기·운영자 처리)은 전부 그 제보를 다시 판정(settleInTx)하고 끝난다.
 * ★ 판정의 할 일(effects)은 실행이 옮긴다 — vod_priority 면 판독 요청 표(0097)에 그 제보의 줄을 두고, 제보가 닫히면 열린 요청을 거둔다(syncEffectsInTx).
 *   판독이 끝나 요청이 닫히면(settleVodRequests — ck:queue finish·access·plan) 그 제보들을 같은 트랜잭션에서 다시 판정한다.
 * ★ VOD 단서(0098)는 공개 기록을 바꾸지 않는다 — 판독이 그 VOD 의 경기를 기록하면 경기는 판독 경기로 이미 집계에 있고, 단서는 확인으로 닫힌다.
 * ★ 반영은 기존 쓰기 길 하나 — `applyMatchReviewInTx`(writer member). 제보만의 쓰기 SQL 을 두지 않는다(근거·잠금·이력·승패 재계산이 같이 온다).
 * ★ 중복 막기 네 겹(§6): 요청 번호(UNIQUE author×request) · 내용 지문(열린 제보 중 유일 → +1) · 같은 칸(다른 값이면 보류) · 이미 그 값(거부).
 *   같은 판의 제보는 그 판 행을 잠근 뒤 판정하므로 동시에 들어와도 지문 판정이 엇갈리지 않는다. 잠금 순서: 회원 → 판 → 제보.
 * ★ 되돌리기는 그 제보의 이력(review_change.submission_id)만 역순으로 되돌린다. 그 뒤 누가 같은 칸을 또 바꿨으면 아무것도 되돌리지 않는다.
 * ★ 반영 방향(사용자 결정 2026-10-18 — 기준 2026-10-18.1): 경기 고치기는 운영자 확인 대기(correction_review) → 확인하면 운영자 이름으로 반영.
 *   편성표 제보(0094)는 바로 반영 + 확인 전 — 어댑터가 saveScheduleEntryInTx(편성표 쓰기의 단일 출처)로 쓰고 되돌리기 원본을
 *   submission_schedule_effect(0100)에 남긴다. 반려하면 그 원본으로 되돌린다(그 뒤 또 바뀌었으면 거부). 보류된 편성표 제보(다툼·방송 칸 여럿)는
 *   운영자가 편성표 편집 폼으로 저장할 때 applyScheduleReport 가 한 트랜잭션에서 저장 → 제보 닫기를 한다. 편성표를 쓰는 SQL 은 여기에 없다.
 *   공개 일정 읽기도 schedule-public.ts 하나를 쓴다. 의존은 submission → schedule 한 방향(경기 쪽 submission → ck 와 같다).
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";

import { isUuid } from "../metrics/community.ts";
import type { MemberRole } from "../metrics/member-role.ts";
import {
  additionSetTime, additionStreamers, isSameSeriesCandidate, normalizeMatchAddition, type MatchAddition,
} from "../metrics/addition.ts";
import { soopVodId } from "../metrics/vod-request.ts";
import { decide, POLICY, shownIn, stateOf, type Facts, type IntakeFacts, type Policy, type Verdict, type VodFact } from "../metrics/submission-policy.ts";
import { kstClock } from "../metrics/schedule.ts";
import {
  cellsOverlap, correctionCells, fingerprintSource, normalizeEvidenceUrl, normalizeMatchCorrection, normalizeNote,
  normalizeScheduleReport, normalizeVodHint, scheduleInputFromReport, scheduleReportHasChange, SUBMISSION_DAILY_LIMIT, SubmissionInputError, matchStreamerNames, vodClock,
  type CorrectionParticipantField, type HoldReason, type MatchCorrection, type ScheduleReport, type SubmissionContent, type SubmissionKind, type SubmissionState,
  type VodHint,
} from "../metrics/submission.ts";
import { ADMIN_WRITER, applyMatchReviewInTx, lockCkMatchWritesInTx, type MatchReviewPatch, type ReviewWriter } from "./ck.ts";
import { adoptPovValuesInTx } from "./ck-pov.ts";
import { ensureAutoBucketInTx, placeSetInTx } from "./classification.ts";
import { resolveChampion } from "./participant.ts";
import { db } from "./client.ts";
import { lockMember, lockSessionMember, memberFromSession, MemberError } from "./member.ts";
import { activeRolesInTx, grantRoleInTx, revokeRoleInTx } from "./member-role.ts";
import {
  cancelSubmissionVodRequestsInTx, closeVodRequestsInTx, requestVodInTx, submissionVodRequestInTx, vodMatchesInTx,
} from "./vod-request.ts";
import { saveScheduleEntryInTx, ScheduleSaveError, scheduleInputInTx, type ScheduleSaveOptions } from "./schedule.ts";
import { getPublicScheduleEntry, type PublicScheduleEntry } from "./schedule-public.ts";
import type { ScheduleInput } from "../metrics/schedule.ts";
import { PARTICIPANT_ROW_FIELD } from "./review-lock.ts";

type Tx = postgres.TransactionSql;
type Sql = postgres.Sql | Tx;

/** 화면에 그대로 보여 주는 제보 거부(회원 쓰기와 같은 모양). */
export class SubmissionError extends MemberError {
  constructor(message: string) { super(message); this.name = "SubmissionError"; }
}

export type SubmissionRow = SubmissionContent & {
  id: string; match_id: string | null; schedule_entry_id: string | null; state: SubmissionState;
  hold_reason: HoldReason | null; note: string | null; evidence_url: string | null;
  created_at: Date; decided_at: Date | null; decision_note: string | null; supporters: number;
};

export type SubmitOutcome =
  | { kind: "applied" | "held" | "verified"; id: string; hold_reason: HoldReason | null }
  /** 같은 내용의 열린 제보가 있어 +1 로 합쳤다(또는 이미 +1 했다). */
  | { kind: "supported"; id: string }
  /** 같은 요청을 다시 받았다(두 번 누르기·재시도) — 처음 결과의 제보. */
  | { kind: "repeat"; id: string };

const fingerprint = (kind: SubmissionKind, target: string, payload: unknown) =>
  createHash("sha256").update(fingerprintSource(kind, target, payload)).digest("hex");

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function input<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof SubmissionInputError) throw new SubmissionError(e.message); throw e; }
}

// ── 판 읽기(잠근 뒤) ─────────────────────────────────────────────────────────

interface MatchState {
  match_id: string; game_code: string; collected_via: string; scope: string; visibility: string;
  winning_team: number | null; review_completed_at: Date | null;
}
interface SlotState {
  participant_id: number; puuid: string | null; streamer_id: string | null; observed_name: string | null; team_id: number;
  team_position: string | null; individual_position: string | null; champion_id: number | null; champion_name: string | null;
  kills: number | null; deaths: number | null; assists: number | null;
}

async function lockMatchState(tx: Tx, matchId: string): Promise<{ match: MatchState; slots: Map<number, SlotState> } | null> {
  const [match] = await tx<MatchState[]>`
    SELECT match_id, game_code, collected_via, scope, visibility, winning_team, review_completed_at
      FROM match WHERE match_id = ${matchId} FOR UPDATE`;
  if (!match) return null;
  const rows = await tx<SlotState[]>`
    SELECT participant_id, puuid, streamer_id, observed_name, team_id, team_position, individual_position,
           champion_id, champion_name, kills, deaths, assists
      FROM match_participant WHERE match_id = ${matchId}`;
  return { match, slots: new Map(rows.map((r) => [r.participant_id, r])) };
}

/**
 * 지금 값과 대조 — 이미 그 값인 칸은 지우고(겹 4), 화면이 본 값(from)이 지금 값과 다르면 거부한다(그 사이 바뀌었다).
 * 남는 것이 없으면 null.
 */
function againstCurrent(c: MatchCorrection, match: MatchState, slots: Map<number, SlotState>): MatchCorrection | null {
  const out: MatchCorrection = {};
  const stale = () => { throw new SubmissionError("그 사이 이 경기의 값이 바뀌었습니다. 새로고침한 뒤 다시 확인해 주세요."); };
  if (c.winning_team && !same(match.winning_team, c.winning_team.to)) {
    if (!same(match.winning_team, c.winning_team.from)) stale();
    out.winning_team = c.winning_team;
  }
  const parts: NonNullable<MatchCorrection["participants"]> = [];
  for (const p of c.participants ?? []) {
    const cur = slots.get(p.participant_id);
    if (!cur) stale();
    const changes: typeof p.changes = {};
    for (const [f, ch] of Object.entries(p.changes) as [CorrectionParticipantField, { from: unknown; to: unknown }][]) {
      const now = (cur as unknown as Record<string, unknown>)[f];
      if (same(now, ch.to)) continue;
      if (!same(now, ch.from)) stale();
      changes[f] = ch;
    }
    if (Object.keys(changes).length) parts.push({ participant_id: p.participant_id, changes });
    // 자리에는 사람(계정·스트리머·화면 이름) 하나는 남아야 한다 — 다 비우면 "없던 자리"가 된다(0020). 자리를 없애려면 지우기.
    const after = { ...cur, ...Object.fromEntries(Object.entries(changes).map(([f, ch]) => [f, ch!.to])) } as SlotState;
    if (!after.puuid && !after.streamer_id && !after.observed_name) {
      throw new SubmissionError(`${p.participant_id}번 자리에 사람(스트리머 또는 화면 이름)이 남아야 합니다 — 없던 자리면 지우기를 골라 주세요.`);
    }
  }
  if (parts.length) out.participants = parts;
  const remove = (c.remove ?? []).filter((id) => slots.has(id));
  if (remove.length) out.remove = remove;
  for (const a of c.add ?? []) if (slots.has(a.participant_id)) throw new SubmissionError(`${a.participant_id}번 자리는 이미 있습니다 — 그 자리를 고쳐 주세요.`);
  if (c.add?.length) out.add = c.add;
  return Object.keys(out).length ? out : null;
}

/**
 * 접수 사실(경기 고치기) — 대상에서 본 것을 **전부** 적는다. 어느 것이 보류인지·무엇이 먼저인지는 판정(submission-policy.ts)이 정한다.
 * 같은 칸 다툼(contested) = 같은 칸을 다른 값으로 고친 확인 전 제보가 있다(겹 3).
 */
async function matchIntakeInTx(tx: Tx, c: MatchCorrection, match: MatchState, slots: Map<number, SlotState>): Promise<IntakeFacts> {
  const accountSlot = (id: number) => Boolean(slots.get(id)?.puuid);
  const mine = correctionCells(c);
  const open = await tx<{ payload: MatchCorrection }[]>`
    SELECT payload FROM submission WHERE match_id = ${match.match_id} AND state IN ('applied', 'held')`;
  const facts: IntakeFacts = {
    not_public: match.visibility !== "public" || match.scope !== "versus",
    review_completed: Boolean(match.review_completed_at),
    api_observed: match.collected_via === "api",
    account_identity: (c.participants ?? []).some((p) => accountSlot(p.participant_id) && ("streamer_id" in p.changes || "observed_name" in p.changes))
      || (c.remove ?? []).some(accountSlot),
    contested: open.some((o) => correctionCells(o.payload).some((x) => mine.some((y) => cellsOverlap(x, y)))),
  };
  return Object.fromEntries(Object.entries(facts).filter(([, v]) => v)) as IntakeFacts;
}

/** 제안 → 기존 검수 경로의 고치기(기대값 = 화면이 본 값). 포지션은 두 칸을 함께(어긋나면 맞라인에서 빠진다 — 원칙 10). */
function toReviewPatch(c: MatchCorrection, slots: Map<number, SlotState>): MatchReviewPatch {
  const patch: MatchReviewPatch = {};
  if (c.winning_team) patch.match = { changes: { winning_team: c.winning_team.to } as never, expect: { winning_team: c.winning_team.from } };
  const participants: NonNullable<MatchReviewPatch["participants"]> = {};
  for (const p of c.participants ?? []) {
    const cur = slots.get(p.participant_id)!;
    const changes: Record<string, unknown> = {}, expect: Record<string, unknown> = {};
    for (const [f, ch] of Object.entries(p.changes) as [CorrectionParticipantField, { from: unknown; to: unknown }][]) {
      changes[f] = ch.to; expect[f] = ch.from;
      if (f === "champion_id") { changes.champion_name = null; expect.champion_name = cur.champion_name; }
      if (f === "team_position") { changes.individual_position = ch.to; expect.individual_position = cur.individual_position; }
    }
    // 챔피언은 번호로 고친다 — 이름은 번호에서 나온다(resolveChampion). 이름 칸을 비워 넘기면 검수 경로가 번호로 채운다.
    if ("champion_id" in changes) delete changes.champion_name;
    (participants.patch ??= []).push({ participant_id: p.participant_id, changes: changes as never, expect });
  }
  if (c.remove?.length) participants.remove = c.remove;
  if (c.add?.length) participants.add = c.add.map((a) => ({ ...a, individual_position: a.team_position }));
  if (Object.keys(participants).length) patch.participants = participants;
  return patch;
}

// ── 회원: 접수 ───────────────────────────────────────────────────────────────

export interface MatchCorrectionInput {
  /** 폼마다 만든 요청 번호(uuid) — 같은 폼을 두 번 보내도 제보는 하나다. */
  request_id: string;
  match_id: string;
  payload: unknown;
  note?: string | null;
  evidence_url?: string | null;
}

/** 경기 고치기 제보. 바로 반영(applied)·보류(held)·+1(supported)·같은 요청(repeat) 중 하나. */
export async function submitMatchCorrection(token: string | null, raw: MatchCorrectionInput, now = new Date()): Promise<SubmitOutcome> {
  if (!isUuid(raw.request_id)) throw new SubmissionError("요청 번호가 올바르지 않습니다. 새로고침해 주세요.");
  const proposed = input(() => normalizeMatchCorrection(raw.payload));
  const note = input(() => normalizeNote(raw.note)), evidence = input(() => normalizeEvidenceUrl(raw.evidence_url));
  return db().begin(async (tx) => {
    // 잠금 순서: 회원 → 판. 제재 중이면 제보도 막힌다(제재 하나로 — 개념을 늘리지 않는다).
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    // 겹 1 — 같은 요청.
    const [repeat] = await tx<{ id: string }[]>`SELECT id FROM submission WHERE author_id = ${m.id} AND request_id = ${raw.request_id}::uuid`;
    if (repeat) return { kind: "repeat", id: repeat.id } as const;
    if (!proposed) throw new SubmissionError("바뀐 칸이 없습니다.");
    const state = await lockMatchState(tx, raw.match_id);
    if (!state || state.match.game_code !== "lol") throw new SubmissionError("경기를 찾을 수 없습니다.");
    // 겹 4 — 이미 그 값인 칸은 지운다. 다 지워지면 받지 않는다.
    const c = againstCurrent(proposed, state.match, state.slots);
    if (!c) throw new SubmissionError("이미 그 값입니다.");
    await assertStreamersPublic(tx, c);
    // 겹 2 — 열린 제보 중 같은 지문이면 +1.
    const fp = fingerprint("match_correction", raw.match_id, c);
    const twin = await twinOrLimitInTx(tx, m.id, fp, now);
    if (twin) return twin;
    // 겹 3(같은 칸 다툼)과 그 밖의 보류 사실을 적고, 판정·실행은 접수 한 길(admitInTx)로.
    const intake = await matchIntakeInTx(tx, c, state.match, state.slots);
    return admitInTx(tx, {
      author_id: m.id, request_id: raw.request_id, kind: "match_correction", match_id: raw.match_id, schedule_entry_id: null,
      payload: c, fingerprint: fp, note, evidence_url: evidence, intake, now,
    });
  }) as Promise<SubmitOutcome>;
}

async function assertStreamersPublic(tx: Tx, c: MatchCorrection): Promise<void> {
  const ids = [
    ...(c.participants ?? []).map((p) => p.changes.streamer_id?.to),
    ...(c.add ?? []).map((a) => a.streamer_id),
  ].filter((x): x is string => typeof x === "string");
  if (!ids.length) return;
  const found = await tx<{ id: string }[]>`SELECT id FROM streamer WHERE id = ANY(${ids}::uuid[]) AND visibility = 'public'`;
  if (found.length !== new Set(ids).size) throw new SubmissionError("고른 스트리머를 찾을 수 없습니다. 다시 골라 주세요.");
}

/**
 * 겹 2(같은 지문의 열린 제보 → +1)와 하루 한도 — 접수 세 종류가 같이 쓴다. +1 이면 그 결과, 새 제보를 받아도 되면 null.
 * 지문을 가진 행을 잠근다(같은 지문의 동시 접수는 호출한 쪽이 판·일정·권고 잠금으로 줄을 세운다).
 */
async function twinOrLimitInTx(tx: Tx, memberId: string, fp: string, now: Date): Promise<SubmitOutcome | null> {
  const [twin] = await tx<{ id: string; author_id: string | null }[]>`
    SELECT id, author_id FROM submission WHERE fingerprint = ${fp} AND state IN ('applied', 'held') FOR UPDATE`;
  if (twin) {
    if (twin.author_id !== memberId) await supportInTx(tx, twin.id, memberId, now);
    return { kind: "supported", id: twin.id };
  }
  const [{ n }] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM submission WHERE author_id = ${memberId} AND created_at > ${now}::timestamptz - interval '1 day'`;
  if (n >= SUBMISSION_DAILY_LIMIT) throw new SubmissionError(`제보는 하루 ${SUBMISSION_DAILY_LIMIT}건까지 보낼 수 있습니다.`);
  return null;
}

// ── VOD 단서(0098) ──────────────────────────────────────────────────────────

export interface VodHintInput {
  request_id: string;
  payload: unknown;
  note?: string | null;
}

/**
 * VOD 단서 — 공개하지 않는다. 판정(hint_pending)의 할 일로 판독 요청 표에 한 줄(회원 제보 우선순위)이 같은 트랜잭션에 생긴다.
 * 같은 요청(repeat)·같은 지문(VOD + 시점, +1)·하루 한도·제재는 다른 제보와 같다. 근거 링크 칸에는 VOD 주소를 적는다.
 */
export async function submitVodHint(token: string | null, raw: VodHintInput, now = new Date()): Promise<SubmitOutcome> {
  if (!isUuid(raw.request_id)) throw new SubmissionError("요청 번호가 올바르지 않습니다. 새로고침해 주세요.");
  const h = input(() => normalizeVodHint(raw.payload));
  const note = input(() => normalizeNote(raw.note));
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const [repeat] = await tx<{ id: string }[]>`SELECT id FROM submission WHERE author_id = ${m.id} AND request_id = ${raw.request_id}::uuid`;
    if (repeat) return { kind: "repeat", id: repeat.id } as const;
    // 지문 = VOD + 시점(누가 나왔나는 같은 판을 가르지 않는다 — 사람마다 다르게 적는다).
    const fp = fingerprint("vod_hint", `vod:${h.vod}`, { vod: h.vod, from_sec: h.from_sec ?? null, to_sec: h.to_sec ?? null });
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fp}, 0))`;
    const twin = await twinOrLimitInTx(tx, m.id, fp, now);
    if (twin) return twin;
    return admitInTx(tx, {
      author_id: m.id, request_id: raw.request_id, kind: "vod_hint", match_id: null, schedule_entry_id: null,
      payload: h, fingerprint: fp, note, evidence_url: `https://vod.sooplive.com/player/${h.vod}`, intake: {}, now,
    });
  }) as Promise<SubmitOutcome>;
}

// ── 빠진 경기 직접 입력(0099) ──────────────────────────────────────────────────

export interface MatchAdditionInput {
  request_id: string;
  payload: unknown;
  /** VOD 링크(선택). */
  vod_link?: string | null;
  note?: string | null;
}

/**
 * 빠진 경기 직접 입력 — 사람·날짜로 이미 있는 경기인지 본 뒤(metrics/addition.ts isSameSeriesCandidate) 아니면 **바로 공개**·검증 전.
 * 같은 판 후보가 열린 직접 입력이면 그 제보에 +1, 그 밖의 공개 경기면 받지 않는다("그 경기 고치기로").
 * 잠금 순서: 회원 → 판 쓰기 잠금(lockCkMatchWritesInTx — 새 판은 잠글 행이 없어 동시 등록·판독 저장과 줄을 세운다).
 */
export async function submitMatchAddition(token: string | null, raw: MatchAdditionInput, now = new Date()): Promise<SubmitOutcome> {
  if (!isUuid(raw.request_id)) throw new SubmissionError("요청 번호가 올바르지 않습니다. 새로고침해 주세요.");
  const link = String(raw.vod_link ?? "").trim();
  const vod = link ? soopVodId(link) : null;
  if (link && !vod) throw new SubmissionError("VOD 링크는 SOOP 다시보기 주소(vod.sooplive.com/player/번호)로 넣어 주세요.");
  const a = input(() => normalizeMatchAddition(raw.payload, vod));
  const note = input(() => normalizeNote(raw.note));
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const [repeat] = await tx<{ id: string }[]>`SELECT id FROM submission WHERE author_id = ${m.id} AND request_id = ${raw.request_id}::uuid`;
    if (repeat) return { kind: "repeat", id: repeat.id } as const;
    await lockCkMatchWritesInTx(tx);
    if (a.event_id) {
      const [e] = await tx<{ game_code: string; auto_bucket: boolean }[]>`SELECT game_code, auto_bucket FROM event WHERE id = ${a.event_id}::uuid`;
      if (!e || e.game_code !== "lol" || e.auto_bucket) throw new SubmissionError("고른 행사를 찾을 수 없습니다. 다시 골라 주세요.");
    }
    const ids = [...additionStreamers(a).a, ...additionStreamers(a).b];
    const found = await tx<{ id: string }[]>`SELECT id FROM streamer WHERE id = ANY(${ids}::uuid[]) AND visibility = 'public'`;
    if (found.length !== ids.length) throw new SubmissionError("고른 스트리머를 찾을 수 없습니다. 다시 골라 주세요.");
    const dup = await additionDuplicateInTx(tx, a);
    if (dup) {
      // 열린 직접 입력이 만든 판이면 같은 시리즈를 또 등록한 것 — 그 제보에 +1. 아니면 이미 기록된 경기다.
      const [owner] = await tx<{ id: string; author_id: string | null }[]>`
        SELECT s.id, s.author_id FROM submission_effect se JOIN submission s ON s.id = se.submission_id
         WHERE se.match_id = ${dup} AND s.kind = 'match_addition' AND s.state IN ('applied', 'held') FOR UPDATE OF s`;
      if (owner) {
        if (owner.author_id !== m.id) await supportInTx(tx, owner.id, m.id, now);
        return { kind: "supported", id: owner.id } as const;
      }
      throw new SubmissionError(`이미 기록된 경기로 보입니다(${dup}) — 그 경기의 세트 보기에서 제보하기로 고쳐 주세요.`);
    }
    const fp = fingerprint("match_addition", a.on_date, a);
    const twin = await twinOrLimitInTx(tx, m.id, fp, now);
    if (twin) return twin;
    return admitInTx(tx, {
      author_id: m.id, request_id: raw.request_id, kind: "match_addition", match_id: null, schedule_entry_id: null,
      payload: a, fingerprint: fp, note, evidence_url: a.vod ? `https://vod.sooplive.com/player/${a.vod}` : null, intake: {}, now,
    });
  }) as Promise<SubmitOutcome>;
}

/** 같은 KST 날짜의 공개 내전 세트 중 같은 편 사람이 기준 넘게 겹치는 첫 판(없으면 null). 계정의 주인을 사람으로 본다. */
async function additionDuplicateInTx(tx: Tx, a: MatchAddition): Promise<string | null> {
  const from = new Date(`${a.on_date}T00:00:00+09:00`), to = new Date(from.getTime() + 24 * 3600_000);
  const rows = await tx<{ match_id: string; team_id: 100 | 200; person: string | null }[]>`
    SELECT m.match_id, p.team_id, COALESCE(sa.streamer_id, p.streamer_id) AS person
      FROM match m JOIN match_participant p ON p.match_id = m.match_id
      LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
     WHERE m.game_code = 'lol' AND m.scope = 'versus' AND m.visibility = 'public'
       AND m.game_creation >= ${from} AND m.game_creation < ${to}
     ORDER BY m.game_creation, m.match_id`;
  const sets = new Map<string, { 100: string[]; 200: string[] }>();
  for (const r of rows) {
    const set = sets.get(r.match_id) ?? { 100: [], 200: [] };
    if (r.person) set[r.team_id].push(r.person);
    sets.set(r.match_id, set);
  }
  const mine = additionStreamers(a);
  for (const [matchId, set] of sets) if (isSameSeriesCandidate(mine, set)) return matchId;
  return null;
}

/** 직접 입력 폼의 행사 고르기 — 실제 LoL 행사(자동 묶음 제외), 최근 것 먼저. */
export async function listAdditionEventChoices(limit = 300): Promise<{ id: string; name: string; starts_at: Date | null }[]> {
  return db()<{ id: string; name: string; starts_at: Date | null }[]>`
    SELECT id, name, starts_at FROM event WHERE game_code = 'lol' AND NOT auto_bucket
     ORDER BY starts_at DESC NULLS LAST, name LIMIT ${limit}`;
}

/**
 * 판독이 끝났다(done)·영상이 없다(unavailable) — 그 VOD 의 열린 요청을 닫고, 요청한 제보들을 **같은 트랜잭션에서** 다시 판정한다.
 * 이 PC 의 ck:queue(finish·access·plan)가 부른다. 닫을 요청이 없으면 아무것도 안 한다.
 */
export async function settleVodRequests(title_no: number, state: "done" | "unavailable", note: string | null, now = new Date()): Promise<{ closed: number; changed: number }> {
  return db().begin(async (tx) => {
    const { closed, submission_ids } = await closeVodRequestsInTx(tx, title_no, state, note, now);
    let changed = 0;
    for (const id of submission_ids) if (await reconsiderInTx(tx, id)) changed++;
    return { closed, changed };
  });
}

// ── 편성표 제보(0094) ───────────────────────────────────────────────────────

export interface ScheduleReportInput {
  request_id: string;
  /** 고칠 일정. 없는 일정 알리기는 null. */
  entry_id: string | null;
  payload: unknown;
  note?: string | null;
  evidence_url?: string | null;
}

/** 지금 일정과 같은 칸은 지운다(겹 4) — 방송 칸이 하나일 때만 날짜·시각을 대 본다(여럿이면 어느 칸인지 운영자가 본다). */
function scheduleAgainstCurrent(r: ScheduleReport, cur: PublicScheduleEntry): ScheduleReport {
  const out: ScheduleReport = { ...r };
  if (out.title === cur.title) delete out.title;
  if (out.status === cur.status) delete out.status;
  if (out.game_code === cur.game_code) delete out.game_code;
  if (cur.slots.length === 1 && out.on_date === cur.slots[0].on_date) {
    const start = cur.slots[0].starts_at ? kstClock(new Date(cur.slots[0].starts_at)) : null;
    if (out.start === undefined || out.start === start) { delete out.on_date; delete out.start; }
  }
  return out;
}

/**
 * 편성표 제보 — 바로 반영 + 확인 전(2026-10-18, 규칙 schedule_apply). 같은 일정의 열린 제보가 이미 있거나 방송 칸이 여럿인 일정의 날짜면 운영자 대기.
 * 같은 요청(repeat)·같은 지문(+1, supported)은 경기 제보와 같다.
 * 새 일정은 근거 링크가 있어야 한다(공개 일정의 조건이 출처라서 — 사용자 결정). 고치기는 고칠 칸이나 메모 중 하나가 있어야 한다.
 */
export async function submitScheduleReport(token: string | null, raw: ScheduleReportInput, now = new Date()): Promise<SubmitOutcome> {
  if (!isUuid(raw.request_id)) throw new SubmissionError("요청 번호가 올바르지 않습니다. 새로고침해 주세요.");
  const proposed = input(() => normalizeScheduleReport(raw.payload));
  const note = input(() => normalizeNote(raw.note)), evidence = input(() => normalizeEvidenceUrl(raw.evidence_url));
  if (proposed.type === "new" && raw.entry_id) throw new SubmissionError("새 일정 알리기에는 대상 일정이 없습니다.");
  if (proposed.type === "correction" && !raw.entry_id) throw new SubmissionError("고칠 일정을 찾을 수 없습니다.");
  if (proposed.type === "new" && !evidence) throw new SubmissionError("새 일정은 근거 링크(방송 공지·SNS 주소)가 있어야 합니다.");
  // 고칠 일정은 공개 읽기의 단일 출처(getPublicScheduleEntry)로 트랜잭션 **밖에서** 읽는다(그 함수는 자기 연결로 읽는다).
  // 먼저 version 을 적어 두고, 트랜잭션 안에서 행을 잠근 뒤 그대로인지 본다 — 그 사이 바뀌었으면 다시 보내게 한다.
  let cur: PublicScheduleEntry | null = null, seen: string | null = null;
  if (proposed.type === "correction") {
    if (!isUuid(raw.entry_id!)) throw new SubmissionError("일정을 찾을 수 없습니다.");
    const [row] = await db()<{ v: string }[]>`SELECT updated_at::text AS v FROM schedule_entry WHERE id = ${raw.entry_id}::uuid`;
    seen = row?.v ?? null;
    cur = seen ? await getPublicScheduleEntry(raw.entry_id!) : null;
    if (!cur) throw new SubmissionError("일정을 찾을 수 없습니다.");
  }
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const [repeat] = await tx<{ id: string }[]>`SELECT id FROM submission WHERE author_id = ${m.id} AND request_id = ${raw.request_id}::uuid`;
    if (repeat) return { kind: "repeat", id: repeat.id } as const;
    let r = proposed;
    if (cur) {
      // 잠금 순서: 회원 → 일정 → 제보(경기 제보의 회원 → 판 → 제보와 같은 모양).
      const [locked] = await tx<{ v: string }[]>`SELECT updated_at::text AS v FROM schedule_entry WHERE id = ${raw.entry_id}::uuid FOR UPDATE`;
      if (!locked) throw new SubmissionError("일정을 찾을 수 없습니다.");
      if (locked.v !== seen) throw new SubmissionError("그 사이 일정이 바뀌었습니다. 새로고침한 뒤 다시 보내 주세요.");
      r = scheduleAgainstCurrent(r, cur);
      if (!scheduleReportHasChange(r) && !note) {
        throw new SubmissionError(scheduleReportHasChange(proposed) ? "이미 그 값입니다." : "고칠 내용이나 메모를 써 주세요.");
      }
    }
    // 메모만 있는 고치기는 메모까지 지문에 넣는다 — 칸이 없으면 "같은 제보"를 가를 것이 메모뿐이다.
    const target = raw.entry_id ?? "new";
    const fp = fingerprint("schedule_report", target, scheduleReportHasChange(r) ? r : { ...r, note });
    // 새 일정은 잠글 행이 없다 — 같은 지문끼리만 줄을 세운다(동시에 같은 제보 둘이 와도 하나 + +1).
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fp}, 0))`;
    const twin = await twinOrLimitInTx(tx, m.id, fp, now);
    if (twin) return twin;
    // 접수 사실 — 같은 일정에 열린 제보가 이미 있다(다툼) · 방송 칸이 여럿인 일정의 날짜를 바꾼다(어느 칸인지 모른다). 무엇이 보류인지는 규칙이 정한다.
    const intake: IntakeFacts = {};
    if (raw.entry_id) {
      const [other] = await tx`SELECT 1 FROM submission WHERE kind = 'schedule_report' AND schedule_entry_id = ${raw.entry_id}::uuid
                                 AND state IN ('applied', 'held') LIMIT 1`;
      if (other) intake.contested = true;
      if (cur && r.on_date && cur.slots.length > 1) intake.multi_slot = true;
    }
    return admitInTx(tx, {
      author_id: m.id, request_id: raw.request_id, kind: "schedule_report", match_id: null, schedule_entry_id: raw.entry_id,
      payload: r, fingerprint: fp, note, evidence_url: evidence, intake, now,
    });
  }) as Promise<SubmitOutcome>;
}

/**
 * 편성표 제보 반영 — 운영자가 제보 내용으로 고친 편성표를 저장하고(saveScheduleEntryInTx, 편성표 쓰기의 단일 출처)
 * **같은 트랜잭션에서** 제보를 확인 완료로 닫는다. 저장이 실패하면(그 사이 바뀐 일정·검증) 제보도 열린 채다.
 * 잠금 순서: 일정 → 제보(접수와 같다).
 */
export async function applyScheduleReport(id: string, actor: string, input: ScheduleInput, opts: ScheduleSaveOptions = {}): Promise<{ id: string; version: string }> {
  return db().begin(async (tx) => {
    const saved = await saveScheduleEntryInTx(tx, input, opts);
    await closeScheduleReportInTx(tx, id, actor, saved);
    return saved;
  });
}

/** 편성표 제보 닫기 — applyScheduleReport 의 트랜잭션 안에서만. 새 일정 알리기는 만들어진 일정을 대상으로 적는다. */
async function closeScheduleReportInTx(tx: Tx, id: string, actor: string, saved: { id: string; version: string }): Promise<void> {
  const entryId = saved.id;
  const s = await lockOpen(tx, id);
  if (s.kind !== "schedule_report") throw new SubmissionError("편성표 제보가 아닙니다.");
  if (s.schedule_entry_id && s.schedule_entry_id !== entryId) throw new SubmissionError("제보한 일정과 저장한 일정이 다릅니다.");
  await tx`UPDATE submission SET schedule_entry_id = ${entryId}::uuid WHERE id = ${id}::uuid`;
  // 운영자가 편성표 편집으로 반영했다 — 그 저장이 반영이다(흔적 admin). 이미 바로 반영된 제보면 그 흔적이 그대로 남는다.
  // 흔적이 있으면 편성표 어댑터의 show 는 다시 쓰지 않는다. 운영자가 반영했다 = 운영자의 확인 — 판정이 확인 완료로 옮긴다.
  await tx`INSERT INTO submission_schedule_effect (submission_id, entry_id, kind, after_version)
           VALUES (${id}::uuid, ${entryId}::uuid, 'admin', ${saved.version}) ON CONFLICT (submission_id) DO NOTHING`;
  await settleInTx(tx, { ...s, schedule_entry_id: entryId }, { admin: { decision: "verify", actor, note: "편성표에 반영" } });
}

/** "같은 내용이에요(+1)" — 열린 남의 제보에만. 이미 했으면 그대로. 잠금 순서: 회원 → 판 → 제보(lockOpen). */
export async function supportSubmission(token: string | null, id: string, now = new Date()): Promise<void> {
  if (!isUuid(id)) throw new SubmissionError("제보를 찾을 수 없습니다.");
  await db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const s = await lockOpen(tx, id);
    if (s.author_id === m.id) throw new SubmissionError("내가 보낸 제보입니다.");
    await supportInTx(tx, id, m.id, now);
  });
}

/** +1 을 남기고 다시 판정한다(같은 내용 회원 수가 사실이다). 제보 행을 잠근 트랜잭션 안에서만. */
async function supportInTx(tx: Tx, id: string, memberId: string, now: Date): Promise<void> {
  const added = await tx`
    INSERT INTO submission_supporter (submission_id, member_id, created_at) VALUES (${id}::uuid, ${memberId}::uuid, ${now}) ON CONFLICT DO NOTHING`;
  if (!added.count) return;
  const [s] = await tx<SubmissionRecord[]>`SELECT ${RECORD_COLUMNS(tx)} FROM submission WHERE id = ${id}::uuid`;
  await settleInTx(tx, s);
}

// ── 회원: 읽기 ───────────────────────────────────────────────────────────────

const SUBMISSION_COLUMNS = (sql: Sql) => sql`
  s.id, s.kind, s.match_id, s.schedule_entry_id, s.payload, s.state, s.hold_reason, s.note, s.evidence_url, s.created_at, s.decided_at, s.decision_note,
  (SELECT count(*)::int FROM submission_supporter x WHERE x.submission_id = s.id) AS supporters`;

async function viewerId(token: string | null): Promise<string> {
  const m = await memberFromSession(token);
  if (!m) throw new SubmissionError("로그인이 필요합니다.");
  return m.member_id;
}

export async function listMySubmissions(token: string | null, limit = 50): Promise<SubmissionRow[]> {
  const me = await viewerId(token);
  const sql = db();
  return sql<SubmissionRow[]>`
    SELECT ${SUBMISSION_COLUMNS(sql)} FROM submission s WHERE s.author_id = ${me}::uuid
     ORDER BY s.created_at DESC, s.id LIMIT ${Math.min(200, Math.max(1, limit))}`;
}

export async function getMySubmission(token: string | null, id: string): Promise<SubmissionRow | null> {
  const me = await viewerId(token);
  if (!isUuid(id)) return null;
  const sql = db();
  const [row] = await sql<SubmissionRow[]>`SELECT ${SUBMISSION_COLUMNS(sql)} FROM submission s WHERE s.id = ${id}::uuid AND s.author_id = ${me}::uuid`;
  return row ?? null;
}

/** 한 대상(판·일정)의 열린 제보 — 폼이 먼저 보여 주고 +1 을 받는다. 보낸 사람·메모·근거는 내지 않는다(비공개). */
export interface OpenSubmission<P = MatchCorrection> { id: string; state: "applied" | "held"; payload: P; created_at: Date; supporters: number; mine: boolean }
export function listOpenSubmissions(token: string | null, kind: "match_correction", target: string): Promise<OpenSubmission<MatchCorrection>[]>;
export function listOpenSubmissions(token: string | null, kind: "schedule_report", target: string): Promise<OpenSubmission<ScheduleReport>[]>;
export async function listOpenSubmissions(token: string | null, kind: SubmissionKind, target: string): Promise<OpenSubmission<unknown>[]> {
  const me = await viewerId(token);
  if (kind === "schedule_report" && !isUuid(target)) return [];
  const sql = db();
  const onTarget = kind === "match_correction" ? sql`s.match_id = ${target}` : sql`s.schedule_entry_id = ${target}::uuid`;
  return sql<OpenSubmission<unknown>[]>`
    SELECT s.id, s.state, s.payload, s.created_at,
           (SELECT count(*)::int FROM submission_supporter x WHERE x.submission_id = s.id) AS supporters,
           (s.author_id = ${me}::uuid
             OR EXISTS (SELECT 1 FROM submission_supporter x WHERE x.submission_id = s.id AND x.member_id = ${me}::uuid)) AS mine
      FROM submission s WHERE s.kind = ${kind} AND ${onTarget} AND s.state IN ('applied', 'held') ORDER BY s.created_at, s.id`;
}

export interface CorrectionTarget {
  match_id: string; played_at: Date; event_name: string; winning_team: number | null; pending: boolean;
  slots: {
    participant_id: number; team_id: number; streamer_id: string | null; display_name: string | null; observed_name: string | null;
    champion_id: number | null; team_position: string | null; kills: number | null; deaths: number | null; assists: number | null;
    has_account: boolean;
  }[];
}
export async function getCorrectionTarget(matchId: string): Promise<CorrectionTarget | null> {
  const sql = db();
  const rows = await sql<(Omit<CorrectionTarget, "slots"> & CorrectionTarget["slots"][number])[]>`
    SELECT d.match_id, d.played_at, e.name AS event_name, d.winning_team, d.pending,
           d.participant_id, d.team_id, p.streamer_id, s.display_name, p.observed_name, p.champion_id, p.team_position,
           p.kills, p.deaths, p.assists, (p.puuid IS NOT NULL) AS has_account
      FROM core_public.match_detail d
      JOIN core_public.event e ON e.event_id = d.event_id
      JOIN match_participant p ON p.match_id = d.match_id AND p.participant_id = d.participant_id
      LEFT JOIN core_public.streamer s ON s.streamer_id = d.streamer_id
     WHERE d.match_id = ${matchId}
     ORDER BY d.participant_id`;
  if (!rows.length) return null;
  const { match_id, played_at, event_name, winning_team, pending } = rows[0];
  return {
    match_id, played_at, event_name, winning_team, pending,
    slots: rows.map((r) => ({
      participant_id: r.participant_id, team_id: r.team_id, streamer_id: r.streamer_id, display_name: r.display_name,
      observed_name: r.observed_name, champion_id: r.champion_id, team_position: r.team_position,
      kills: r.kills, deaths: r.deaths, assists: r.assists, has_account: r.has_account,
    })),
  };
}

/** 폼·목록의 이름 풀이 — 공개 스트리머(번호 → 이름). */
export async function listStreamerChoices(): Promise<{ id: string; slug: string; display_name: string }[]> {
  return db()<{ id: string; slug: string; display_name: string }[]>`
    SELECT streamer_id AS id, slug, display_name FROM core_public.streamer ORDER BY display_name`;
}

// ── 운영자 ───────────────────────────────────────────────────────────────────

export type QueueItem = SubmissionRow & { author: string | null; played_at: Date | null; event_name: string | null; schedule_title: string | null };

/** 열린 제보 대기열 — 판별로 묶어 +1 많은 것·오래된 것 먼저. */
export async function listSubmissionQueue(limit = 200): Promise<QueueItem[]> {
  const sql = db();
  return sql<QueueItem[]>`
    SELECT ${SUBMISSION_COLUMNS(sql)}, mb.nickname AS author, m.game_creation AS played_at, e.name AS event_name, se.title AS schedule_title
      FROM submission s
      LEFT JOIN member mb ON mb.id = s.author_id
      LEFT JOIN match m ON m.match_id = s.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = ms.event_id
      LEFT JOIN schedule_entry se ON se.id = s.schedule_entry_id
     WHERE s.state IN ('applied', 'held')
     ORDER BY (SELECT count(*) FROM submission_supporter x WHERE x.submission_id = s.id) DESC, s.created_at, s.id
     LIMIT ${limit}`;
}

export type AdminSubmission = QueueItem & {
  decided_by: string | null;
  /** 보낸 회원(탈퇴하면 null)과 그 회원의 지금 권한 — 판정의 사실(reporter.roles)과 같은 읽기. */
  author_id: string | null; author_roles: MemberRole[];
  /** 지금 상태를 정한 판정 규칙과 그때의 기준 버전(metrics/submission-policy.ts) — "어떤 기준으로". */
  rule_id: string | null; policy_version: string | null;
  /** 이 제보가 남긴 이력(applied 였던 것). */
  changes: { id: number; entity: string; entity_key: string; field: string; before: unknown; after: unknown; changed_at: Date }[];
  /** 되돌리면 걸릴 칸 — 이 제보 뒤에 누가 같은 칸을 또 바꿨다. 비어야 되돌릴 수 있다. */
  conflicts: string[];
  /**
   * VOD 를 쓰는 제보(단서·직접 입력)의 판독 — 요청 줄들과 경기(판정의 사실 vod 와 같은 읽기).
   * 단서: 판독이 그 VOD 에 기록한 경기(모두 read) · 직접 입력: 만든 판과 판독 시점이 붙었나(read).
   */
  vod: { requests: { title_no: number; state: string }[]; matches: { match_id: string; read: boolean }[] } | null;
};

export async function getSubmissionForAdmin(id: string): Promise<AdminSubmission | null> {
  if (!isUuid(id)) return null;
  const sql = db();
  const [row] = await sql<(QueueItem & { decided_by: string | null; author_id: string | null; rule_id: string | null; policy_version: string | null })[]>`
    SELECT ${SUBMISSION_COLUMNS(sql)}, s.decided_by, s.author_id, s.rule_id, s.policy_version, mb.nickname AS author, m.game_creation AS played_at, e.name AS event_name, se.title AS schedule_title
      FROM submission s
      LEFT JOIN member mb ON mb.id = s.author_id
      LEFT JOIN match m ON m.match_id = s.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = ms.event_id
      LEFT JOIN schedule_entry se ON se.id = s.schedule_entry_id
     WHERE s.id = ${id}::uuid`;
  if (!row) return null;
  const changes = await changesOf(sql, id);
  const author_roles = row.author_id ? (await activeRolesInTx(sql, [row.author_id])).get(row.author_id) ?? [] : [];
  const va = ADAPTERS[row.kind].vod;
  const vod = va ? {
    requests: await sql<{ title_no: number; state: string }[]>`
      SELECT title_no::float8 AS title_no, state FROM vod_request WHERE submission_id = ${id}::uuid ORDER BY title_no`,
    matches: await va.matches(sql, row),
  } : null;
  return { ...row, author_roles, vod, changes, conflicts: row.state === "applied" ? await conflictsOf(sql, id, changes) : [] };
}

async function changesOf(sql: Sql, id: string): Promise<AdminSubmission["changes"]> {
  return sql<AdminSubmission["changes"]>`
    SELECT id::int AS id, entity, entity_key, field, before, after, changed_at FROM review_change
     WHERE submission_id = ${id}::uuid ORDER BY id`;
}

/** 이 제보 뒤에 같은 칸(자리 행이면 그 자리 전부)을 바꾼 다른 기록. */
async function conflictsOf(sql: Sql, id: string, changes: AdminSubmission["changes"]): Promise<string[]> {
  if (!changes.length) return [];
  const last = Math.max(...changes.map((c) => c.id));
  const [{ match_id }] = await sql<{ match_id: string }[]>`SELECT match_id FROM review_change WHERE id = ${last}`;
  const later = await sql<{ entity: string; entity_key: string; field: string; actor: string }[]>`
    SELECT entity, entity_key, field, actor FROM review_change
     WHERE match_id = ${match_id} AND id > ${last} AND submission_id IS DISTINCT FROM ${id}::uuid
       AND entity IN ('match', 'participant')`;
  const cell = (c: { entity: string; entity_key: string; field: string }) =>
    c.entity === "match" ? `match:${c.field}` : `p${c.entity_key}:${c.field === PARTICIPANT_ROW_FIELD ? "*" : c.field}`;
  const mine = changes.filter((c) => c.entity === "match" || c.entity === "participant").map(cell);
  return [...new Set(later.map(cell).filter((x) => mine.some((y) => cellsOverlap(x, y))))];
}

// ── 판정 실행 ───────────────────────────────────────────────────────────────
//
// 판정은 metrics/submission-policy.ts 가 한다. 여기는 그 판정을 옮길 뿐이다 — 보임이 바뀌면 종류별 어댑터의 show/hide,
// 그리고 상태·규칙·기준 버전을 적는다. 종류마다 다른 것은 "보이게 하기·숨기기"를 어떻게 하느냐뿐이다.

type SubmissionRecord = SubmissionContent & {
  id: string; author_id: string | null; state: SubmissionState; match_id: string | null; schedule_entry_id: string | null;
  intake: IntakeFacts; admin_decision: "verify" | "reject" | null; rule_id: string | null;
};
const RECORD_COLUMNS = (sql: Sql) => sql`id, author_id, kind, state, match_id, schedule_entry_id, payload, intake, admin_decision, rule_id`;

/** 지금 판정에 쓰는 기준. 바꾸는 길은 POLICY(코드)뿐이다 — 아래 함수는 verify:db 가 꺼 둔 규칙을 켜서 시험할 때만 쓴다. */
let policy: Policy = POLICY;
export function setSubmissionPolicyForVerify(p: Policy | null): void { policy = p ?? POLICY; }

/**
 * 판정이 보는 사실 — 여기 하나에서 모은다. 접수 순간(id = null)에는 +1 이 없다.
 * 같은 내용 회원 = 보낸 사람 + +1(서로 다른 회원 — supporter 는 보낸 사람을 넣지 않는다). 탈퇴한 보낸 사람은 세지 않는다.
 */
async function factsInTx(tx: Tx, s: { id: string | null; author_id: string | null; intake: IntakeFacts } & SubmissionContent,
                         admin: "verify" | "reject" | null): Promise<Facts> {
  const supporters = s.id
    ? (await tx<{ member_id: string }[]>`SELECT member_id FROM submission_supporter WHERE submission_id = ${s.id}::uuid`).map((r) => r.member_id)
    : [];
  const people = [...new Set([...(s.author_id ? [s.author_id] : []), ...supporters])];
  const roles = await activeRolesInTx(tx, people);
  return {
    kind: s.kind, intake: s.intake, admin,
    reporter: { roles: s.author_id ? roles.get(s.author_id) ?? [] : [] },
    agreement: { members: people.length, trusted: people.filter((id) => roles.get(id)?.includes("trusted_reporter")).length },
    vod: { state: await vodFactInTx(tx, s) },
  };
}

/** 보임이 바뀔 때 종류마다 하는 일. writer = 누가 일으킨 판정인가(회원 접수 = member + 제보 번호, 운영자 처리 = admin). */
interface KindAdapter {
  show(tx: Tx, s: SubmissionRecord, writer: ReviewWriter): Promise<void>;
  hide(tx: Tx, s: SubmissionRecord): Promise<void>;
  /** VOD 판독으로 검증하는 종류만 — 판정의 사실 vod 의 재료. */
  vod?: VodAdapter;
  /** 할 일 adopt_vod — 판독 값이 다른 칸을 판독 값으로 덮는다. */
  adopt?(tx: Tx, s: { id: string } & SubmissionContent): Promise<void>;
}

type VodSubject = { id: string } & SubmissionContent;
interface VodAdapter {
  /** 판독할 VOD 번호(요청할 것). 비면 판독할 VOD 를 못 찾았다(no_vod). */
  vods(tx: Sql, s: { id: string | null } & SubmissionContent): Promise<number[]>;
  /** 판독이 그 경기를 찾았나. */
  found(tx: Sql, s: VodSubject): Promise<boolean>;
  /** 운영 화면의 경기 줄. */
  matches(tx: Sql, s: VodSubject): Promise<{ match_id: string; read: boolean }[]>;
  /** 판독 요청 메모 — 자동 판독 지시문으로 넘어간다. **회원이 쓴 글을 넣지 않는다**(숫자·등록 이름·경기 번호만). */
  note(tx: Sql, s: VodSubject): Promise<string | null>;
}

/** 이 제보가 만든 판(직접 입력) — submission_effect. */
const effectMatches = async (sql: Sql, id: string) =>
  (await sql<{ match_id: string }[]>`SELECT match_id FROM submission_effect WHERE submission_id = ${id}::uuid ORDER BY match_id`).map((r) => r.match_id);

/** 흔적에 JSON 으로 남긴 일정 입력 → 저장 입력(시각 글자를 Date 로). */
function reviveScheduleInput(j: ScheduleInput): ScheduleInput {
  const at = (v: unknown) => (v == null ? null : new Date(v as string));
  return {
    ...j,
    slots: j.slots.map((x) => ({ ...x, starts_at: at(x.starts_at), ends_at: at(x.ends_at) })),
    sources: j.sources.map((x) => ({ ...x, posted_at: at(x.posted_at) })),
  };
}

/** 등록 이름(공개 스트리머) — 판독 요청 메모에 넣어도 되는 이름. */
async function streamerNamesInTx(sql: Sql, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM streamer WHERE id = ANY(${ids as string[]}::uuid[]) AND visibility = 'public'`;
  const name = new Map(rows.map((r) => [r.id, r.display_name]));
  return ids.flatMap((id) => (name.has(id) ? [name.get(id)!] : []));
}

const ADAPTERS: Record<SubmissionKind, KindAdapter> = {
  match_correction: {
    // 반영 — 기존 검수 경로 하나(기대값 = 제보가 본 값, 그 사이 바뀌었으면 검수 경로가 충돌로 거부한다).
    async show(tx, s, writer) {
      const st = s.match_id ? await lockMatchState(tx, s.match_id) : null;
      if (!st) throw new SubmissionError("대상 경기가 지워져 반영할 수 없습니다 — 반려해 주세요.");
      await applyMatchReviewInTx(tx, st.match.match_id, toReviewPatch(s.payload as MatchCorrection, st.slots), writer);
      // 회원이 바꾼 판의 흔적 — 확인 전 표시(core_public.pending_match)가 읽는다.
      if (writer.actor === "member") await tx`INSERT INTO submission_effect (submission_id, match_id) VALUES (${s.id}::uuid, ${st.match.match_id}) ON CONFLICT DO NOTHING`;
    },
    // 되돌리기 — 그 제보의 이력만 역순으로(운영자 이름). 그 뒤 같은 칸을 누가 또 바꿨으면 하나도 되돌리지 않는다.
    async hide(tx, s) {
      const changes = await changesOf(tx, s.id);
      const conflicts = await conflictsOf(tx, s.id, changes);
      if (conflicts.length) {
        throw new SubmissionError(`이 제보 뒤에 같은 칸이 또 바뀌어 되돌릴 수 없습니다: ${conflicts.join(", ")} — 검수 화면에서 직접 고친 뒤 확인해 주세요.`);
      }
      const st = s.match_id ? await lockMatchState(tx, s.match_id) : null;
      if (st && changes.length) await applyMatchReviewInTx(tx, st.match.match_id, inversePatch(changes, st.slots), ADMIN_WRITER);
    },
  },
  schedule_report: {
    // 바로 반영(2026-10-18) — 편성표 쓰기의 단일 출처(saveScheduleEntryInTx)로. 되돌리기 원본을 흔적(submission_schedule_effect)에 남긴다.
    // 흔적이 이미 있으면(운영자가 편집 저장으로 반영했거나 이미 반영됨) 다시 쓰지 않는다.
    async show(tx, s) {
      const [had] = await tx`SELECT 1 FROM submission_schedule_effect WHERE submission_id = ${s.id}::uuid`;
      if (had) return;
      const r = s.payload as ScheduleReport;
      const [{ evidence_url }] = await tx<{ evidence_url: string | null }[]>`SELECT evidence_url FROM submission WHERE id = ${s.id}::uuid`;
      let matched: string[] | null = null;
      if (r.participants) {
        const streamers = await tx<{ id: string; slug: string; display_name: string }[]>`SELECT id, slug, display_name FROM streamer WHERE visibility = 'public'`;
        const bySlug = new Map(streamers.map((x) => [x.slug, x.id]));
        matched = matchStreamerNames(r.participants, streamers).slugs.map((slug) => bySlug.get(slug)!);
      }
      const save = async (inputValue: ScheduleInput, opts: ScheduleSaveOptions) => {
        try { return await saveScheduleEntryInTx(tx, inputValue, opts); } catch (e) {
          if (e instanceof ScheduleSaveError) throw new SubmissionError(`편성표에 반영할 수 없습니다: ${e.reasons.join(" / ")}`);
          throw e;
        }
      };
      if (r.type === "correction") {
        if (!s.schedule_entry_id) throw new SubmissionError("고칠 일정을 찾을 수 없습니다.");
        await tx`SELECT 1 FROM schedule_entry WHERE id = ${s.schedule_entry_id}::uuid FOR UPDATE`;
        const cur = await scheduleInputInTx(tx, s.schedule_entry_id);
        if (!cur) throw new SubmissionError("일정이 지워져 반영할 수 없습니다 — 반려해 주세요.");
        const saved = await save(input(() => scheduleInputFromReport(cur.input, r, evidence_url, matched)), { id: s.schedule_entry_id, version: cur.version });
        await tx`INSERT INTO submission_schedule_effect (submission_id, entry_id, kind, before, after_version)
                 VALUES (${s.id}::uuid, ${saved.id}::uuid, 'changed', ${tx.json(cur.input as never)}, ${saved.version})`;
        return;
      }
      const saved = await save(input(() => scheduleInputFromReport(null, r, evidence_url, matched)), {});
      await tx`UPDATE submission SET schedule_entry_id = ${saved.id}::uuid WHERE id = ${s.id}::uuid`;
      await tx`INSERT INTO submission_schedule_effect (submission_id, entry_id, kind, after_version)
               VALUES (${s.id}::uuid, ${saved.id}::uuid, 'made', ${saved.version})`;
    },
    // 반려(되돌리기) — 고친 일정은 고치기 전 입력으로, 만든 일정은 숨김으로. 그 뒤 누가 또 저장했으면(version 이 다르면) 아무것도 바꾸지 않는다.
    // 운영자가 편집으로 반영한 것(admin)은 되돌리지 않는다.
    async hide(tx, s) {
      const [eff] = await tx<{ entry_id: string; kind: "made" | "changed" | "admin"; before: ScheduleInput | null; after_version: string }[]>`
        SELECT entry_id, kind, before, after_version FROM submission_schedule_effect WHERE submission_id = ${s.id}::uuid`;
      if (!eff || eff.kind === "admin") return;
      await tx`SELECT 1 FROM schedule_entry WHERE id = ${eff.entry_id}::uuid FOR UPDATE`;
      const cur = await scheduleInputInTx(tx, eff.entry_id);
      if (!cur) return;   // 일정이 지워졌다 — 되돌릴 것이 없다
      if (cur.version !== eff.after_version) {
        throw new SubmissionError("이 제보 뒤에 일정이 또 바뀌어 되돌릴 수 없습니다 — 편성표 편집에서 직접 고친 뒤 확인해 주세요.");
      }
      const back = eff.kind === "made" ? { ...cur.input, visibility: "hidden" as const } : reviveScheduleInput(eff.before!);
      await saveScheduleEntryInTx(tx, back, { id: eff.entry_id, version: cur.version });
    },
  },
  vod_hint: {
    // 단서는 공개 기록을 바꾸지 않는다 — 판독이 기록한 경기는 판독 길(ck:merge)로 이미 들어가 있다.
    async show() {},
    async hide() {},
    vod: {
      vods: async (_tx, s) => (s.kind === "vod_hint" ? [s.payload.vod] : []),
      // 요청한 판독이 끝났고 그 VOD(시점을 줬으면 앞뒤 30분)에 판독이 기록한 경기가 있다.
      async found(tx, s) {
        if (s.kind !== "vod_hint") return false;
        const done = await submissionVodRequestInTx(tx, s.id, s.payload.vod);
        return done === "done" && (await vodMatchesInTx(tx, s.payload.vod, s.payload)).length > 0;
      },
      matches: async (tx, s) => (s.kind === "vod_hint" ? (await vodMatchesInTx(tx, s.payload.vod, s.payload)).map((match_id) => ({ match_id, read: true })) : []),
      async note(tx, s) {
        if (s.kind !== "vod_hint") return null;
        const parts: string[] = [];
        if (s.payload.from_sec !== undefined) parts.push(`시점 ${vodClock(s.payload.from_sec)}${s.payload.to_sec !== undefined ? `~${vodClock(s.payload.to_sec)}` : " 무렵"}`);
        if (s.payload.people) {
          const streamers = await tx<{ slug: string; display_name: string }[]>`SELECT slug, display_name FROM streamer WHERE visibility = 'public'`;
          const name = new Map(streamers.map((x) => [x.slug, x.display_name]));
          const { slugs } = matchStreamerNames(s.payload.people, streamers);
          if (slugs.length) parts.push(`나온 사람(등록 이름) ${slugs.map((x) => name.get(x)).join(", ")}`);
        }
        return parts.length ? `회원 단서: ${parts.join(" · ")}` : "회원 단서";
      },
    },
  },
  match_addition: {
    // 공개 — 판 행 + 분류 쓰기(placeSetInTx) 한 길. 판은 sub:<제보>:<세트>, 시리즈는 sub:<제보>. 확인 전 흔적(submission_effect)을 같이 남긴다.
    // 이미 만든 판이면(운영자가 숨긴 뒤 다시 보이게 할 때) 공개로 되돌리기만 한다.
    async show(tx, s) {
      const made = await effectMatches(tx, s.id);
      if (made.length) {
        for (const m of made) await applyMatchReviewInTx(tx, m, { visibility: "public" }, ADMIN_WRITER);
        return;
      }
      await createAdditionMatchesInTx(tx, s.id, s.payload as MatchAddition);
    },
    // 반려 = 만든 판 숨기기(되돌릴 이력이 없다 — 판 자체가 제보다). 숨긴 판은 목록에서도 빠진다.
    async hide(tx, s) {
      for (const m of await effectMatches(tx, s.id)) await applyMatchReviewInTx(tx, m, { visibility: "hidden" }, ADMIN_WRITER);
    },
    vod: {
      // 링크를 줬으면 그 VOD, 아니면 그날 참가 스트리머 채널의 VOD(단서 행 — 매일 조사가 만든다) 최대 4개.
      async vods(tx, s) {
        if (s.kind !== "match_addition") return [];
        if (s.payload.vod) return [s.payload.vod];
        const { a, b } = additionStreamers(s.payload);
        const t0 = additionSetTime(s.payload, 0);
        const rows = await tx<{ n: number }[]>`
          SELECT DISTINCT substr(l.source_key, 5)::float8 AS n FROM event_lead l
            JOIN streamer_channel c ON c.channel_id = l.channel_id AND c.platform = 'soop'
           WHERE l.source = 'vod_title' AND l.source_key ~ '^vod:[0-9]+$' AND c.streamer_id = ANY(${[...a, ...b]}::uuid[])
             AND l.observed_at >= ${t0} AND l.observed_at < ${new Date(t0.getTime() + 18 * 3600_000)}
           ORDER BY n LIMIT 4`;
        return rows.map((r) => r.n);
      },
      // 만든 판 **모두**에 판독 시점이 붙었다(같은 판이라고 판독이 이었다). 일부만이면 운영자가 본다.
      async found(tx, s) {
        const rows = await tx<{ match_id: string; n: number }[]>`
          SELECT se.match_id, count(p.lead_id)::int AS n FROM submission_effect se LEFT JOIN match_pov p ON p.match_id = se.match_id
           WHERE se.submission_id = ${s.id}::uuid GROUP BY se.match_id`;
        return rows.length > 0 && rows.every((r) => r.n > 0);
      },
      matches: async (tx, s) => (await tx<{ match_id: string; read: boolean }[]>`
        SELECT se.match_id, EXISTS (SELECT 1 FROM match_pov p WHERE p.match_id = se.match_id) AS read
          FROM submission_effect se WHERE se.submission_id = ${s.id}::uuid ORDER BY se.match_id`),
      async note(tx, s) {
        if (s.kind !== "match_addition") return null;
        const made = await effectMatches(tx, s.id);
        const { a, b } = additionStreamers(s.payload);
        const names = await streamerNamesInTx(tx, [...a, ...b]);
        const ids = made.length > 1 ? `sub:${s.id}:1~${made.length}` : made[0] ?? `sub:${s.id}:1`;
        return `회원 직접 입력 경기 ${ids} (${s.payload.on_date} ${s.payload.start} 무렵 시작, 등록 이름 ${names.join(", ")}) — `
          + "같은 판이면 새 경기를 만들지 말고 이 경기 번호에 시점을 더한다(pov role added)";
      },
    },
    async adopt(tx, s) {
      for (const m of await effectMatches(tx, s.id)) await adoptPovValuesInTx(tx, m);
    },
  },
};

/**
 * 판정이 보는 VOD 사실 — 종류의 VOD 어댑터(어느 VOD·찾았나)와 이 제보의 요청 줄들.
 * 찾았으면 found, 열린 요청이 있으면 queued, 요청이 없으면 판독할 VOD 가 있나(none·no_vod), 다 닫혔으면 unavailable(전부 영상 없음)·not_found.
 */
async function vodFactInTx(tx: Tx, s: { id: string | null } & SubmissionContent): Promise<VodFact> {
  const a = ADAPTERS[s.kind].vod;
  if (!a) return "none";
  if (!s.id) return (await a.vods(tx, s)).length ? "none" : "no_vod";
  const subject = { ...s, id: s.id };
  if (await a.found(tx, subject)) return "found";
  const reqs = (await tx<{ state: string }[]>`SELECT state FROM vod_request WHERE submission_id = ${s.id}::uuid`)
    .map((r) => r.state).filter((x) => x !== "cancelled");
  if (reqs.some((x) => x === "queued" || x === "claimed")) return "queued";
  if (!reqs.length) return (await a.vods(tx, s)).length ? "none" : "no_vod";
  return reqs.every((x) => x === "unavailable") ? "unavailable" : "not_found";
}

/**
 * 판정의 할 일을 옮긴다(멱등).
 *   adopt_vod    판독 값으로 덮기(어댑터 adopt)
 *   vod_priority 열린 동안 판독할 VOD 마다 요청 줄(이미 있으면 그대로 — 판독이 끝난 줄도 다시 만들지 않는다)
 * 제보가 닫히면 그 제보의 열린 요청을 거둔다.
 */
async function syncEffectsInTx(tx: Tx, s: { id: string } & SubmissionContent, v: Verdict, next: SubmissionState, now: Date): Promise<void> {
  const adapter = ADAPTERS[s.kind];
  if (v.effects.includes("adopt_vod")) await adapter.adopt?.(tx, s);
  if (!adapter.vod) return;
  if (next !== "applied" && next !== "held") { await cancelSubmissionVodRequestsInTx(tx, s.id, `제보가 닫혀 거둠(${next})`, now); return; }
  if (!v.effects.includes("vod_priority")) return;
  const vods = await adapter.vod.vods(tx, s);
  if (!vods.length) return;
  const note = await adapter.vod.note(tx, s);
  for (const title_no of vods) await requestVodInTx(tx, { title_no, reason: "submission", submission_id: s.id, requested_by: "policy", note }, now);
}

/**
 * 직접 입력의 판을 만든다 — 판 행(수기 manual·날짜 정확도) + 분류 쓰기(placeSetInTx — 새 판이라 사람의 제외가 있을 수 없어 auto 로 둔다)
 * + 참가자 + 확인 전 흔적. 행사를 모르면 그날의 회원 등록 미분류 묶음(자동 묶음 — 이름은 운영자·판독이 실제 행사로 옮겨 정한다).
 */
async function createAdditionMatchesInTx(tx: Tx, submissionId: string, a: MatchAddition): Promise<void> {
  await lockCkMatchWritesInTx(tx);
  const eventId = a.event_id ?? await ensureAutoBucketInTx(tx, {
    game_code: "lol", slug: `lol-member-auto-${a.on_date}`, name: `${a.on_date} 회원 등록 내전(행사 미정)`, day: additionSetTime(a, 0),
  });
  const seriesId = `sub:${submissionId}`;
  for (const [i, set] of a.sets.entries()) {
    const matchId = `${seriesId}:${i + 1}`;
    const winning = set.winner === "a" ? set.a_side : (set.a_side === 100 ? 200 : 100);
    await tx`
      INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, game_creation, winning_team, collected_via, scope,
                         source_url, game_creation_precision)
      VALUES (${matchId}, 'lol', 0, '0', ${a.map === "aram" ? "ARAM" : "CLASSIC"}, ${a.map === "aram" ? 12 : 11}, ${additionSetTime(a, i)}, ${winning},
              'manual', 'personal', ${a.vod ? `https://vod.sooplive.com/player/${a.vod}` : null}, 'date')`;
    await placeSetInTx(tx, { match_id: matchId, game_no: i + 1, actor: "auto", series: { id: seriesId, game_code: "lol", event_id: eventId } });
    const seat = { 100: 1, 200: 6 };
    for (const team of ["a", "b"] as const) {
      const side: 100 | 200 = team === "a" ? set.a_side : (set.a_side === 100 ? 200 : 100);
      for (const [k, p] of a.teams[team].entries()) {
        const st = set.stats?.[`${team}${k}`] ?? {};
        const champ = resolveChampion(st.champion_id ?? null, null);
        await tx`
          INSERT INTO match_participant (match_id, participant_id, team_id, side_no, streamer_id, observed_name, champion_id, champion_name, outcome, kills, deaths, assists)
          VALUES (${matchId}, ${seat[side]++}, ${side}, ${side === 100 ? 1 : 2}, ${"streamer_id" in p ? p.streamer_id : null}::uuid,
                  ${"name" in p ? p.name : null}, ${champ.champion_id}, ${champ.champion_name}, ${side === winning ? "win" : "loss"},
                  ${st.kills ?? null}, ${st.deaths ?? null}, ${st.assists ?? null})`;
      }
    }
    await tx`INSERT INTO submission_effect (submission_id, match_id) VALUES (${submissionId}::uuid, ${matchId})`;
  }
}

interface InsertSubmission {
  author_id: string; request_id: string; kind: SubmissionKind; match_id: string | null; schedule_entry_id: string | null;
  payload: unknown; fingerprint: string; note: string | null; evidence_url: string | null; intake: IntakeFacts; now: Date;
}

/** 접수 — 판정하고, 그 상태로 적고, 보이면 반영한다(회원 이름 + 제보 번호). 접수의 유일한 쓰기. 접수 순간에 검증될 수도 있다(신뢰 계정). */
async function admitInTx(tx: Tx, n: InsertSubmission): Promise<SubmitOutcome> {
  const content = { kind: n.kind, payload: n.payload } as SubmissionContent;
  const v = decide(await factsInTx(tx, { id: null, author_id: n.author_id, intake: n.intake, ...content }, null), policy);
  const state = stateOf(v, false);
  if (state !== "applied" && state !== "held" && state !== "verified") throw new Error(`접수 판정이 받을 수 있는 상태가 아닙니다: ${v.rule}`);
  const decided = state === "verified";
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO submission (author_id, request_id, kind, match_id, schedule_entry_id, payload, fingerprint, note, evidence_url,
                            state, hold_reason, intake, rule_id, policy_version, decided_by, decided_at, created_at, updated_at)
    VALUES (${n.author_id}::uuid, ${n.request_id}::uuid, ${n.kind}, ${n.match_id}, ${n.schedule_entry_id}::uuid, ${tx.json(n.payload as never)},
            ${n.fingerprint}, ${n.note}, ${n.evidence_url}, ${state}, ${v.hold_reason}, ${tx.json(n.intake as never)},
            ${v.rule}, ${policy.version}, ${decided ? "policy" : null}, ${decided ? n.now : null}, ${n.now}, ${n.now})
    RETURNING id`;
  if (v.visibility === "shown") {
    const [rec] = await tx<SubmissionRecord[]>`SELECT ${RECORD_COLUMNS(tx)} FROM submission WHERE id = ${row.id}::uuid`;
    await ADAPTERS[n.kind].show(tx, rec, { actor: "member", submission_id: row.id });
  }
  await syncEffectsInTx(tx, { id: row.id, ...content }, v, state, n.now);
  return { kind: state, id: row.id, hold_reason: v.hold_reason };
}

/**
 * 다시 판정하고 옮긴다 — 운영자 처리(admin)가 있으면 그 사실을 더한 뒤. 판정이 그대로면 아무것도 하지 않는다(멱등).
 * 보임: 숨김 → 보임이면 show, 보임 → 숨김이면 hide. 상태·규칙·기준 버전은 언제나 같이 적는다.
 */
async function settleInTx(tx: Tx, s: SubmissionRecord, opts: { admin?: { decision: "verify" | "reject"; actor: string; note: string | null } } = {}): Promise<void> {
  const admin = opts.admin?.decision ?? s.admin_decision;
  const v = decide(await factsInTx(tx, s, admin), policy);
  const wasShown = shownIn(s.state);
  const next = stateOf(v, wasShown);
  // 할 일은 판정이 그대로여도 맞춘다(멱등 — 요청 줄이 이미 있으면 그대로).
  if (next === s.state && v.rule === s.rule_id && admin === s.admin_decision) { await syncEffectsInTx(tx, s, v, next, new Date()); return; }
  const writer: ReviewWriter = opts.admin ? ADMIN_WRITER : { actor: "member", submission_id: s.id };
  if (!wasShown && v.visibility === "shown") await ADAPTERS[s.kind].show(tx, s, writer);
  if (wasShown && v.visibility === "hidden") await ADAPTERS[s.kind].hide(tx, s);
  const decided = next !== "applied" && next !== "held";
  await tx`
    UPDATE submission SET state = ${next}, hold_reason = COALESCE(${v.hold_reason}, hold_reason), admin_decision = ${admin},
           rule_id = ${v.rule}, policy_version = ${policy.version},
           decided_by = ${decided ? opts.admin?.actor ?? "policy" : null}, decided_at = CASE WHEN ${decided}::boolean THEN now() END,
           decision_note = ${decided ? opts.admin?.note ?? null : null}, updated_at = now()
     WHERE id = ${s.id}::uuid`;
  await syncEffectsInTx(tx, s, v, next, new Date());
}

/** 열린 제보 하나를 잠그고 판정 재료째 읽는다. 잠금 순서: 판 → 제보(접수와 같게). 판 번호를 먼저 잠금 없이 읽고, 잠근 뒤 다시 본다. */
async function lockOpen(tx: Tx, id: string): Promise<SubmissionRecord> {
  if (!isUuid(id)) throw new SubmissionError("제보를 찾을 수 없습니다.");
  const s = await tryLockOpen(tx, id);
  if (s === "missing") throw new SubmissionError("제보를 찾을 수 없습니다.");
  if (s === "closed") throw new SubmissionError("이미 처리된 제보입니다. 새로고침해 주세요.");
  if (s === "moved") throw new SubmissionError("그 사이 제보가 바뀌었습니다. 새로고침해 주세요.");
  return s;
}

async function tryLockOpen(tx: Tx, id: string): Promise<SubmissionRecord | "missing" | "closed" | "moved"> {
  const [peek] = await tx<{ match_id: string | null; schedule_entry_id: string | null }[]>`SELECT match_id, schedule_entry_id FROM submission WHERE id = ${id}::uuid`;
  if (!peek) return "missing";
  // 잠금 순서: 판·일정 → 제보(접수와 같게 — 편성표 제보도 접수가 일정을 먼저 잠근다).
  if (peek.match_id) await tx`SELECT 1 FROM match WHERE match_id = ${peek.match_id} FOR UPDATE`;
  if (peek.schedule_entry_id) await tx`SELECT 1 FROM schedule_entry WHERE id = ${peek.schedule_entry_id}::uuid FOR UPDATE`;
  const [s] = await tx<SubmissionRecord[]>`SELECT ${RECORD_COLUMNS(tx)} FROM submission WHERE id = ${id}::uuid FOR UPDATE`;
  if (!s || !["applied", "held"].includes(s.state)) return "closed";
  if (s.match_id !== peek.match_id) return "moved";
  return s;
}

/**
 * 확인 — 운영자의 확인을 사실로 더하고 판정한다. 확인 전(보임)은 표시만 떨어지고, 보류(숨김)는 운영자 이름으로 지금 반영된다
 * (기대값은 제보가 본 값 — 그 사이 바뀌었으면 검수 경로가 충돌로 거부한다). 편성표 제보는 반영 없이 닫힌다.
 */
export async function verifySubmission(id: string, actor: string, note?: string | null): Promise<void> {
  const memo = input(() => normalizeNote(note));
  await db().begin(async (tx) => settleInTx(tx, await lockOpen(tx, id), { admin: { decision: "verify", actor, note: memo } }));
}

/** 반려 — 운영자의 반려를 사실로 더하고 판정한다. 확인 전(보임)은 그 제보가 남긴 것을 되돌리고, 보류는 바뀐 것이 없다. */
export async function rejectSubmission(id: string, actor: string, note?: string | null): Promise<void> {
  const memo = input(() => normalizeNote(note));
  await db().begin(async (tx) => settleInTx(tx, await lockOpen(tx, id), { admin: { decision: "reject", actor, note: memo } }));
}

/**
 * 열린 제보를 지금 기준으로 다시 판정한다 — 기준(POLICY)이 바뀌었을 때. 판정이 그대로인 제보는 건드리지 않는다(몇 번 돌려도 같다).
 * 운영자의 결정은 규칙 맨 위라 뒤집히지 않는다. 바뀐 수를 돌려준다.
 */
export async function reconsiderOpenSubmissions(): Promise<number> {
  const ids = await db()<{ id: string }[]>`SELECT id FROM submission WHERE state IN ('applied', 'held') ORDER BY created_at, id`;
  let changed = 0;
  for (const { id } of ids) if (await db().begin((tx) => reconsiderInTx(tx, id))) changed++;
  return changed;
}

/** 하나 다시 판정 — 그 사이 닫혔으면 건너뛴다. 바뀌었으면 true. */
async function reconsiderInTx(tx: Tx, id: string): Promise<boolean> {
  const s = await tryLockOpen(tx, id);
  if (typeof s === "string") return false;
  await settleInTx(tx, s);
  const [after] = await tx<{ state: string; rule_id: string }[]>`SELECT state, rule_id FROM submission WHERE id = ${id}::uuid`;
  return after.state !== s.state || after.rule_id !== s.rule_id;
}

// ── 계정 권한 — 주고 거두면 그 회원이 보냈거나 +1 한 열린 제보를 다시 판정한다 ──────────────

/** 권한 주기(운영자). 잠금 순서: 회원 → 판 → 제보. 다시 판정해 바뀐 제보 수를 돌려준다. */
export async function grantMemberRole(memberId: string, role: string, note: string, actor: string, now = new Date()): Promise<number> {
  if (!isUuid(memberId)) throw new SubmissionError("회원을 찾을 수 없습니다.");
  return db().begin(async (tx) => {
    const m = await lockMember(tx, memberId);
    if (m.status !== "active") throw new SubmissionError("탈퇴한 회원에게는 권한을 줄 수 없습니다.");
    await grantRoleInTx(tx, memberId, role, note, actor, now);
    return reconsiderMemberInTx(tx, memberId);
  });
}

/** 권한 거두기(운영자). 이미 검증된 제보는 그대로다 — 그때의 기준으로 닫힌 것이다. */
export async function revokeMemberRole(memberId: string, role: string, actor: string, now = new Date()): Promise<number> {
  if (!isUuid(memberId)) throw new SubmissionError("회원을 찾을 수 없습니다.");
  return db().begin(async (tx) => {
    await lockMember(tx, memberId);
    await revokeRoleInTx(tx, memberId, role, actor, now);
    return reconsiderMemberInTx(tx, memberId);
  });
}

async function reconsiderMemberInTx(tx: Tx, memberId: string): Promise<number> {
  const ids = await tx<{ id: string }[]>`
    SELECT id FROM submission WHERE state IN ('applied', 'held') AND (author_id = ${memberId}::uuid
       OR id IN (SELECT submission_id FROM submission_supporter WHERE member_id = ${memberId}::uuid))
     ORDER BY created_at, id`;
  let changed = 0;
  for (const { id } of ids) if (await reconsiderInTx(tx, id)) changed++;
  return changed;
}

/** 이력 → 되돌리는 고치기. 기대값은 제보가 남긴 값(after) — 그 사이 바뀌었으면 검수 경로가 충돌로 거부한다. */
function inversePatch(changes: AdminSubmission["changes"], slots: Map<number, SlotState>): MatchReviewPatch {
  const patch: MatchReviewPatch = {};
  const meta: Record<string, unknown> = {}, metaExpect: Record<string, unknown> = {};
  const byPid = new Map<number, { changes: Record<string, unknown>; expect: Record<string, unknown> }>();
  const remove: number[] = [], add: NonNullable<NonNullable<MatchReviewPatch["participants"]>["add"]> = [];
  for (const c of [...changes].reverse()) {
    if (c.entity === "match") { meta[c.field] = c.before; metaExpect[c.field] = c.after; continue; }
    if (c.entity !== "participant") continue;
    const pid = Number(c.entity_key);
    if (c.field === PARTICIPANT_ROW_FIELD) {
      if (c.after != null) remove.push(pid);
      else if (c.before != null) {
        const b = c.before as Record<string, unknown>;
        add.push({
          participant_id: pid, puuid: (b.puuid as string) ?? null, streamer_id: (b.streamer_id as string) ?? null,
          observed_name: (b.observed_name as string) ?? null, team_id: b.team_id as 100 | 200,
          team_position: (b.team_position as string) ?? null, individual_position: (b.individual_position as string) ?? null,
          champion_id: (b.champion_id as number) ?? null, champion_name: (b.champion_name as string) ?? null,
          kills: (b.kills as number) ?? null, deaths: (b.deaths as number) ?? null, assists: (b.assists as number) ?? null,
        });
      }
      continue;
    }
    const slot = byPid.get(pid) ?? { changes: {}, expect: {} };
    slot.changes[c.field] = c.before; slot.expect[c.field] = c.after;
    byPid.set(pid, slot);
  }
  if (Object.keys(meta).length) patch.match = { changes: meta as never, expect: metaExpect };
  const participants: NonNullable<MatchReviewPatch["participants"]> = {};
  const edits = [...byPid].map(([participant_id, v]) => {
    // 챔피언 칸은 번호와 이름이 함께 움직인다 — 검수 경로는 둘의 기대값을 다 요구한다. 이름이 이력에 없으면(같았다) 지금 이름.
    if ("champion_id" in v.changes) {
      if (!("champion_name" in v.expect)) v.expect.champion_name = slots.get(participant_id)?.champion_name ?? null;
      delete v.changes.champion_name;
    }
    return { participant_id, changes: v.changes as never, expect: v.expect };
  });
  if (edits.length) participants.patch = edits;
  if (remove.length) participants.remove = remove;
  if (add.length) participants.add = add;
  if (Object.keys(participants).length) patch.participants = participants;
  return patch;
}

/** 중복 — 보류 중인 제보를 다른 열린 제보에 합친다(+1 로 옮긴다). 반영된 제보는 반려로 되돌린다. */
export async function markSubmissionDuplicate(id: string, of: string, actor: string): Promise<void> {
  if (id === of) throw new SubmissionError("같은 제보입니다.");
  await db().begin(async (tx) => {
    const s = await lockOpen(tx, id);
    if (s.state !== "held") throw new SubmissionError("반영된 제보는 중복으로 합칠 수 없습니다 — 반려하면 되돌립니다.");
    const [target] = await tx<{ state: string }[]>`SELECT state FROM submission WHERE id = ${of}::uuid FOR UPDATE`;
    if (!target || !["applied", "held"].includes(target.state)) throw new SubmissionError("합칠 제보가 열려 있지 않습니다.");
    await tx`
      INSERT INTO submission_supporter (submission_id, member_id)
      SELECT ${of}::uuid, m FROM (SELECT author_id AS m FROM submission WHERE id = ${id}::uuid AND author_id IS NOT NULL
                                  UNION SELECT member_id FROM submission_supporter WHERE submission_id = ${id}::uuid) x
       WHERE m IS DISTINCT FROM (SELECT author_id FROM submission WHERE id = ${of}::uuid)
      ON CONFLICT DO NOTHING`;
    // 합침은 판정이 아니다(제보 A → B) — 판정 축 밖의 상태로 적는다.
    await tx`UPDATE submission SET state = 'duplicate', duplicate_of = ${of}::uuid, decided_by = ${actor}, decided_at = now(), updated_at = now()
              WHERE id = ${id}::uuid`;
    // 합친 쪽이 같은 VOD 를 요청해 두었으면 거둔다(남는 제보의 요청이 그 VOD 를 이미 맡는다).
    await cancelSubmissionVodRequestsInTx(tx, id, "중복으로 합쳐 거둠");
  });
}

/** 운영 화면 할 일 수 — 열린 제보. */
export async function countOpenSubmissions(): Promise<number> {
  const [{ n }] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM submission WHERE state IN ('applied', 'held')`;
  return n;
}
