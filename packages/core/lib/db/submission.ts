/**
 * **사용자 제보의 단일 출처** — 접수·중복 막기·보류 판정·반영·확인·반려(되돌리기)·목록. docs/USER-SUBMISSION-PLAN.md (0093).
 *
 *   회원(쿠키 토큰을 계약·화면이 넘긴다)  submitMatchCorrection · submitScheduleReport · supportSubmission · listMySubmissions · getMySubmission
 *                                          · listOpenSubmissions
 *   운영자(requireAdmin 뒤, actor 글자)    listSubmissionQueue · getSubmissionForAdmin · verifySubmission · rejectSubmission · markSubmissionDuplicate
 *                                          · applyScheduleReport(편성표 저장 + 제보 닫기를 한 트랜잭션에서)
 *
 * ★ 반영은 기존 쓰기 길 하나 — `applyMatchReviewInTx`(writer member). 제보만의 쓰기 SQL 을 두지 않는다(근거·잠금·이력·승패 재계산이 같이 온다).
 * ★ 중복 막기 네 겹(§6): 요청 번호(UNIQUE author×request) · 내용 지문(열린 제보 중 유일 → +1) · 같은 칸(다른 값이면 보류) · 이미 그 값(거부).
 *   같은 판의 제보는 그 판 행을 잠근 뒤 판정하므로 동시에 들어와도 지문 판정이 엇갈리지 않는다. 잠금 순서: 회원 → 판 → 제보.
 * ★ 되돌리기는 그 제보의 이력(review_change.submission_id)만 역순으로 되돌린다. 그 뒤 누가 같은 칸을 또 바꿨으면 아무것도 되돌리지 않는다.
 * ★ 편성표 제보(0094)는 바로 반영하지 않는다 — 언제나 보류(schedule_review)로 받고, 운영자가 편성표 편집 폼으로 저장할 때
 *   applyScheduleReport 가 한 트랜잭션에서 saveScheduleEntryInTx(편성표 쓰기의 단일 출처) → 제보 닫기를 한다. 편성표를 쓰는 SQL 은 여기에 없다.
 *   공개 일정 읽기도 schedule-public.ts 하나를 쓴다. 의존은 submission → schedule 한 방향(경기 쪽 submission → ck 와 같다).
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";

import { isUuid } from "../metrics/community.ts";
import { kstClock } from "../metrics/schedule.ts";
import {
  cellsOverlap, correctionCells, fingerprintSource, normalizeEvidenceUrl, normalizeMatchCorrection, normalizeNote,
  normalizeScheduleReport, scheduleReportHasChange, SUBMISSION_DAILY_LIMIT, SubmissionInputError,
  type CorrectionParticipantField, type HoldReason, type MatchCorrection, type ScheduleReport, type SubmissionContent, type SubmissionKind, type SubmissionState,
} from "../metrics/submission.ts";
import { ADMIN_WRITER, applyMatchReviewInTx, type MatchReviewPatch, type ReviewWriter } from "./ck.ts";
import { db } from "./client.ts";
import { lockSessionMember, memberFromSession, MemberError } from "./member.ts";
import { saveScheduleEntryInTx, type ScheduleSaveOptions } from "./schedule.ts";
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
  | { kind: "applied" | "held"; id: string; hold_reason: HoldReason | null }
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

/** 바로 반영하나, 보류하나(§4). 보류 이유 하나를 고른다 — 앞의 것이 먼저다. */
async function holdReasonInTx(tx: Tx, c: MatchCorrection, match: MatchState, slots: Map<number, SlotState>): Promise<HoldReason | null> {
  if (match.visibility !== "public" || match.scope !== "versus") return "not_public";
  if (match.review_completed_at) return "review_completed";
  if (match.collected_via === "api") return "api_observed";
  const accountSlot = (id: number) => Boolean(slots.get(id)?.puuid);
  if ((c.participants ?? []).some((p) => accountSlot(p.participant_id) && ("streamer_id" in p.changes || "observed_name" in p.changes))
    || (c.remove ?? []).some(accountSlot)) return "account_identity";
  const mine = correctionCells(c);
  const open = await tx<{ payload: MatchCorrection }[]>`
    SELECT payload FROM submission WHERE match_id = ${match.match_id} AND state = 'applied'`;
  if (open.some((o) => correctionCells(o.payload).some((x) => mine.some((y) => cellsOverlap(x, y))))) return "contested";
  return null;
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
    const [twin] = await tx<{ id: string; author_id: string | null }[]>`
      SELECT id, author_id FROM submission WHERE fingerprint = ${fp} AND state IN ('applied', 'held') FOR UPDATE`;
    if (twin) {
      if (twin.author_id !== m.id) {
        await tx`INSERT INTO submission_supporter (submission_id, member_id, created_at) VALUES (${twin.id}::uuid, ${m.id}::uuid, ${now}) ON CONFLICT DO NOTHING`;
      }
      return { kind: "supported", id: twin.id } as const;
    }
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM submission WHERE author_id = ${m.id} AND created_at > ${now}::timestamptz - interval '1 day'`;
    if (n >= SUBMISSION_DAILY_LIMIT) throw new SubmissionError(`제보는 하루 ${SUBMISSION_DAILY_LIMIT}건까지 보낼 수 있습니다.`);
    // 겹 3 — 같은 칸을 다른 값으로 고친 확인 전 제보가 있으면 보류(contested). 그 밖의 보류 이유도 여기서.
    const hold = await holdReasonInTx(tx, c, state.match, state.slots);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO submission (author_id, request_id, kind, match_id, payload, fingerprint, note, evidence_url, state, hold_reason, created_at, updated_at)
      VALUES (${m.id}::uuid, ${raw.request_id}::uuid, 'match_correction', ${raw.match_id}, ${tx.json(c as never)}, ${fp},
              ${note}, ${evidence}, ${hold ? "held" : "applied"}, ${hold}, ${now}, ${now})
      RETURNING id`;
    if (!hold) {
      const writer: ReviewWriter = { actor: "member", submission_id: row.id };
      await applyMatchReviewInTx(tx, raw.match_id, toReviewPatch(c, state.slots), writer);
      await tx`INSERT INTO submission_effect (submission_id, match_id) VALUES (${row.id}::uuid, ${raw.match_id})`;
    }
    return { kind: hold ? "held" : "applied", id: row.id, hold_reason: hold } as const;
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
 * 편성표 제보 — 언제나 보류(schedule_review)로 받는다. 같은 요청(repeat)·같은 지문(+1, supported)은 경기 제보와 같다.
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
    const [twin] = await tx<{ id: string; author_id: string | null }[]>`
      SELECT id, author_id FROM submission WHERE fingerprint = ${fp} AND state IN ('applied', 'held') FOR UPDATE`;
    if (twin) {
      if (twin.author_id !== m.id) {
        await tx`INSERT INTO submission_supporter (submission_id, member_id, created_at) VALUES (${twin.id}::uuid, ${m.id}::uuid, ${now}) ON CONFLICT DO NOTHING`;
      }
      return { kind: "supported", id: twin.id } as const;
    }
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM submission WHERE author_id = ${m.id} AND created_at > ${now}::timestamptz - interval '1 day'`;
    if (n >= SUBMISSION_DAILY_LIMIT) throw new SubmissionError(`제보는 하루 ${SUBMISSION_DAILY_LIMIT}건까지 보낼 수 있습니다.`);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO submission (author_id, request_id, kind, schedule_entry_id, payload, fingerprint, note, evidence_url, state, hold_reason, created_at, updated_at)
      VALUES (${m.id}::uuid, ${raw.request_id}::uuid, 'schedule_report', ${raw.entry_id}::uuid, ${tx.json(r as never)}, ${fp},
              ${note}, ${evidence}, 'held', 'schedule_review', ${now}, ${now})
      RETURNING id`;
    return { kind: "held", id: row.id, hold_reason: "schedule_review" } as const;
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
    await closeScheduleReportInTx(tx, id, actor, saved.id);
    return saved;
  });
}

/** 편성표 제보 닫기 — applyScheduleReport 의 트랜잭션 안에서만. 새 일정 알리기는 만들어진 일정을 대상으로 적는다. */
async function closeScheduleReportInTx(tx: Tx, id: string, actor: string, entryId: string): Promise<void> {
  if (!isUuid(id)) throw new SubmissionError("제보를 찾을 수 없습니다.");
  const [s] = await tx<{ kind: string; state: string; schedule_entry_id: string | null }[]>`
    SELECT kind, state, schedule_entry_id FROM submission WHERE id = ${id}::uuid FOR UPDATE`;
  if (!s || s.kind !== "schedule_report") throw new SubmissionError("편성표 제보가 아닙니다.");
  if (s.state !== "held") throw new SubmissionError("이미 처리된 제보입니다. 새로고침해 주세요.");
  if (s.schedule_entry_id && s.schedule_entry_id !== entryId) throw new SubmissionError("제보한 일정과 저장한 일정이 다릅니다.");
  await tx`UPDATE submission SET schedule_entry_id = ${entryId}::uuid WHERE id = ${id}::uuid`;
  await decide(tx, id, "verified", actor, "편성표에 반영");
}

/** "같은 내용이에요(+1)" — 열린 남의 제보에만. 이미 했으면 그대로. */
export async function supportSubmission(token: string | null, id: string, now = new Date()): Promise<void> {
  if (!isUuid(id)) throw new SubmissionError("제보를 찾을 수 없습니다.");
  await db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const [s] = await tx<{ author_id: string | null; state: string }[]>`SELECT author_id, state FROM submission WHERE id = ${id}::uuid FOR UPDATE`;
    if (!s || !["applied", "held"].includes(s.state)) throw new SubmissionError("이미 처리된 제보입니다.");
    if (s.author_id === m.id) throw new SubmissionError("내가 보낸 제보입니다.");
    await tx`INSERT INTO submission_supporter (submission_id, member_id, created_at) VALUES (${id}::uuid, ${m.id}::uuid, ${now}) ON CONFLICT DO NOTHING`;
  });
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
  /** 이 제보가 남긴 이력(applied 였던 것). */
  changes: { id: number; entity: string; entity_key: string; field: string; before: unknown; after: unknown; changed_at: Date }[];
  /** 되돌리면 걸릴 칸 — 이 제보 뒤에 누가 같은 칸을 또 바꿨다. 비어야 되돌릴 수 있다. */
  conflicts: string[];
};

export async function getSubmissionForAdmin(id: string): Promise<AdminSubmission | null> {
  if (!isUuid(id)) return null;
  const sql = db();
  const [row] = await sql<(QueueItem & { decided_by: string | null })[]>`
    SELECT ${SUBMISSION_COLUMNS(sql)}, s.decided_by, mb.nickname AS author, m.game_creation AS played_at, e.name AS event_name, se.title AS schedule_title
      FROM submission s
      LEFT JOIN member mb ON mb.id = s.author_id
      LEFT JOIN match m ON m.match_id = s.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = ms.event_id
      LEFT JOIN schedule_entry se ON se.id = s.schedule_entry_id
     WHERE s.id = ${id}::uuid`;
  if (!row) return null;
  const changes = await changesOf(sql, id);
  return { ...row, changes, conflicts: row.state === "applied" ? await conflictsOf(sql, id, changes) : [] };
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

type OpenRow = SubmissionContent & { id: string; state: SubmissionState; match_id: string | null };
async function lockOpen(tx: Tx, id: string): Promise<OpenRow> {
  if (!isUuid(id)) throw new SubmissionError("제보를 찾을 수 없습니다.");
  // 잠금 순서: 판 → 제보(접수와 같게). 판 번호를 먼저 잠금 없이 읽고, 잠근 뒤 다시 본다.
  const [peek] = await tx<{ match_id: string | null }[]>`SELECT match_id FROM submission WHERE id = ${id}::uuid`;
  if (!peek) throw new SubmissionError("제보를 찾을 수 없습니다.");
  if (peek.match_id) await tx`SELECT 1 FROM match WHERE match_id = ${peek.match_id} FOR UPDATE`;
  const [s] = await tx<OpenRow[]>`
    SELECT id, kind, state, match_id, payload FROM submission WHERE id = ${id}::uuid FOR UPDATE`;
  if (!s || !["applied", "held"].includes(s.state)) throw new SubmissionError("이미 처리된 제보입니다. 새로고침해 주세요.");
  if (s.match_id !== peek.match_id) throw new SubmissionError("그 사이 제보가 바뀌었습니다. 새로고침해 주세요.");
  return s;
}

async function decide(tx: Tx, id: string, state: SubmissionState, actor: string, note: string | null, duplicateOf: string | null = null): Promise<void> {
  await tx`
    UPDATE submission SET state = ${state}, decided_by = ${actor}, decided_at = now(), decision_note = ${note},
           duplicate_of = ${duplicateOf}::uuid, updated_at = now()
     WHERE id = ${id}::uuid`;
}

/**
 * 확인 — applied 는 표시만 뗀다(값은 이미 반영됐다). held 는 운영자 이름으로 지금 반영한다
 * (기대값은 제보가 본 값 — 그 사이 바뀌었으면 검수 경로가 충돌로 거부한다).
 */
export async function verifySubmission(id: string, actor: string, note?: string | null): Promise<void> {
  const memo = input(() => normalizeNote(note));
  await db().begin(async (tx) => {
    const s = await lockOpen(tx, id);
    // 편성표 제보의 "확인"은 반영 없이 닫기다(운영자가 이미 편성표를 고쳤거나 고칠 것이 없다). 반영은 편성표 편집 저장이 한다.
    if (s.kind === "match_correction" && s.state === "held") {
      if (!s.match_id) throw new SubmissionError("대상 경기가 지워져 반영할 수 없습니다 — 반려해 주세요.");
      const st = await lockMatchState(tx, s.match_id);
      if (!st) throw new SubmissionError("대상 경기가 지워져 반영할 수 없습니다 — 반려해 주세요.");
      await applyMatchReviewInTx(tx, s.match_id, toReviewPatch(s.payload, st.slots), ADMIN_WRITER);
    }
    await decide(tx, id, "verified", actor, memo);
  });
}

/**
 * 반려 — applied 는 그 제보의 이력을 역순으로 되돌린다(운영자 이름 — 운영자가 원래 값이 맞다고 본 것이다). held 는 바뀐 것이 없다.
 * 이 제보 뒤에 같은 칸을 누가 또 바꿨으면 **하나도 되돌리지 않고** 거부한다 — 운영자가 검수 화면에서 직접 고친 뒤 확인하면 된다.
 */
export async function rejectSubmission(id: string, actor: string, note?: string | null): Promise<void> {
  const memo = input(() => normalizeNote(note));
  await db().begin(async (tx) => {
    const s = await lockOpen(tx, id);
    if (s.state === "held") return decide(tx, id, "rejected", actor, memo);
    const changes = await changesOf(tx, id);
    const conflicts = await conflictsOf(tx, id, changes);
    if (conflicts.length) {
      throw new SubmissionError(`이 제보 뒤에 같은 칸이 또 바뀌어 되돌릴 수 없습니다: ${conflicts.join(", ")} — 검수 화면에서 직접 고친 뒤 확인해 주세요.`);
    }
    const st = s.match_id ? await lockMatchState(tx, s.match_id) : null;
    if (st && changes.length) await applyMatchReviewInTx(tx, st.match.match_id, inversePatch(changes, st.slots), ADMIN_WRITER);
    await decide(tx, id, "reverted", actor, memo);
  });
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
    await decide(tx, id, "duplicate", actor, null, of);
  });
}

/** 운영 화면 할 일 수 — 열린 제보. */
export async function countOpenSubmissions(): Promise<number> {
  const [{ n }] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM submission WHERE state IN ('applied', 'held')`;
  return n;
}
