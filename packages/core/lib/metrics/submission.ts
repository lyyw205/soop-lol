/**
 * 사용자 제보의 **순수 규칙** — 제안을 정규화하고, 지문의 재료(정규 문자열)를 만들고, 한도·이름표를 둔다. DB 를 모른다.
 * 쓰기·보류 판정·되돌리기는 db/submission.ts. 설계: docs/USER-SUBMISSION-PLAN.md.
 *
 * ★ 정규화가 중복 막기의 바탕이다 — 같은 뜻의 제안은 언제나 같은 글자가 된다(칸 순서·자리 순서·빈 칸·이미 그 값인 칸을 지운 뒤).
 */

import { SCHEDULE_GAME_LABEL, SCHEDULE_GAMES, type ScheduleGame } from "./schedule.ts";

export const SUBMISSION_KINDS = ["match_correction", "schedule_report"] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];
export type SubmissionState = "applied" | "held" | "verified" | "reverted" | "rejected" | "duplicate";
export type HoldReason = "review_completed" | "api_observed" | "account_identity" | "contested" | "not_public" | "schedule_review";

/** 회원당 하루 제보 수(결정 C). +1 은 세지 않는다. */
export const SUBMISSION_DAILY_LIMIT = 20;
export const SUBMISSION_NOTE_MAX = 1000;
export const SUBMISSION_URL_MAX = 500;

export const SUBMISSION_STATE_LABEL: Record<SubmissionState, string> = {
  applied: "반영됨 · 확인 전", held: "운영자 확인 대기", verified: "확인 완료", reverted: "반려(되돌림)", rejected: "반려", duplicate: "중복",
};
export const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  review_completed: "운영자가 검수를 마친 경기라 운영자가 확인한 뒤 바뀝니다",
  api_observed: "게임 서버 기록으로 모은 경기라 운영자가 확인한 뒤 바뀝니다",
  account_identity: "계정이 연결된 자리의 사람은 운영자가 확인한 뒤 바뀝니다",
  contested: "다른 제보가 같은 칸을 다른 값으로 이미 고쳤습니다 — 운영자가 함께 확인합니다",
  not_public: "공개되지 않은 경기입니다",
  schedule_review: "편성표 제보는 운영자가 확인한 뒤 편성표에 반영됩니다",
};

/** 회원이 고칠 수 있는 참가자 칸. 계정(puuid)·챔피언 이름(번호에서 나온다)·개별 포지션은 없다. */
export const CORRECTION_PARTICIPANT_FIELDS = ["streamer_id", "observed_name", "champion_id", "team_position", "kills", "deaths", "assists"] as const;
export type CorrectionParticipantField = (typeof CORRECTION_PARTICIPANT_FIELDS)[number];
export const CORRECTION_POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;

/** 칸 하나의 제안 — 화면이 본 값(from)과 고칠 값(to). from 이 지금 값과 다르면 받지 않는다(그 사이 바뀌었다). */
export interface CellChange<T> { from: T; to: T }

export interface AddedParticipant {
  participant_id: number; team_id: 100 | 200;
  streamer_id: string | null; observed_name: string | null;
  champion_id: number | null; team_position: string | null;
  kills: number | null; deaths: number | null; assists: number | null;
}

/** 경기 고치기 제안(정규화된 모양 — 저장·지문·되돌리기가 이것을 쓴다). */
export interface MatchCorrection {
  winning_team?: CellChange<100 | 200 | null>;
  participants?: { participant_id: number; changes: Partial<Record<CorrectionParticipantField, CellChange<unknown>>> }[];
  add?: AddedParticipant[];
  remove?: number[];
}

export class SubmissionInputError extends Error {
  constructor(message: string) { super(message); this.name = "SubmissionInputError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (m: string): never => { throw new SubmissionInputError(m); };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function slotNo(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : fail(`자리 번호가 올바르지 않습니다: ${String(v)}`);
}
function team(v: unknown): 100 | 200 {
  return v === 100 || v === 200 || v === "100" || v === "200" ? (Number(v) as 100 | 200) : fail("팀은 블루(100) 또는 레드(200)입니다.");
}
function stat(v: unknown, label: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : fail(`${label}은(는) 0~99 사이 정수입니다.`);
}

/** 칸 하나의 값을 그 칸의 형식으로. 비우기는 null. */
export function normalizeCell(field: CorrectionParticipantField, v: unknown): unknown {
  if (v === undefined || v === "") return null;
  switch (field) {
    case "streamer_id": return v === null ? null : UUID.test(String(v)) ? String(v).toLowerCase() : fail("스트리머를 다시 골라 주세요.");
    case "observed_name": {
      if (v === null) return null;
      const t = String(v).trim();
      return t.length >= 1 && t.length <= 32 ? t : fail("화면 이름은 1~32자입니다.");
    }
    case "champion_id": {
      if (v === null) return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 && n < 10000 ? n : fail("챔피언을 다시 골라 주세요.");
    }
    case "team_position": {
      if (v === null) return null;
      const p = String(v).toUpperCase();
      return (CORRECTION_POSITIONS as readonly string[]).includes(p) ? p : fail("포지션은 탑·정글·미드·원딜·서폿 중 하나입니다.");
    }
    case "kills": return stat(v, "킬");
    case "deaths": return stat(v, "데스");
    case "assists": return stat(v, "어시스트");
  }
}

/**
 * 화면이 보낸 제안을 정규 모양으로 — 칸·자리를 정렬하고, from = to 인 칸을 지우고, 형식을 검사한다.
 * 빈 제안은 null(바뀌는 것이 없다). 지금 값과의 대조(이미 그 값·그 사이 바뀜)는 DB 를 보는 쪽이 한다.
 */
export function normalizeMatchCorrection(raw: unknown): MatchCorrection | null {
  if (!raw || typeof raw !== "object") return fail("제안 형식이 올바르지 않습니다.");
  const r = raw as Record<string, unknown>;
  const out: MatchCorrection = {};
  if (r.winning_team && typeof r.winning_team === "object") {
    const w = r.winning_team as Record<string, unknown>;
    const from = w.from === null || w.from === undefined || w.from === "" ? null : team(w.from);
    const to = team(w.to);
    if (from !== to) out.winning_team = { from, to };
  }
  const seen = new Set<number>();
  const parts: NonNullable<MatchCorrection["participants"]> = [];
  for (const p of Array.isArray(r.participants) ? r.participants : []) {
    const id = slotNo((p as Record<string, unknown>).participant_id);
    if (seen.has(id)) fail(`${id}번 자리가 두 번 들어왔습니다.`);
    seen.add(id);
    const ch = ((p as Record<string, unknown>).changes ?? {}) as Record<string, unknown>;
    const changes: Partial<Record<CorrectionParticipantField, CellChange<unknown>>> = {};
    for (const f of CORRECTION_PARTICIPANT_FIELDS) {
      if (!Object.hasOwn(ch, f)) continue;
      const c = ch[f] as Record<string, unknown> | null;
      if (!c || typeof c !== "object") fail("칸 형식이 올바르지 않습니다.");
      const from = normalizeCell(f, c!.from), to = normalizeCell(f, c!.to);
      if (!same(from, to)) changes[f] = { from, to };
    }
    for (const k of Object.keys(ch)) if (!(CORRECTION_PARTICIPANT_FIELDS as readonly string[]).includes(k)) fail(`고칠 수 없는 칸입니다: ${k}`);
    if (Object.keys(changes).length) parts.push({ participant_id: id, changes: sortKeys(changes) });
  }
  if (parts.length) out.participants = parts.sort((a, b) => a.participant_id - b.participant_id);
  const removed = [...new Set((Array.isArray(r.remove) ? r.remove : []).map(slotNo))].sort((a, b) => a - b);
  for (const id of removed) if (seen.has(id)) fail(`${id}번 자리는 고치면서 지울 수 없습니다.`);
  if (removed.length) out.remove = removed;
  const added: AddedParticipant[] = [];
  for (const a of Array.isArray(r.add) ? r.add : []) {
    const x = a as Record<string, unknown>;
    const id = slotNo(x.participant_id);
    if (seen.has(id) || added.some((p) => p.participant_id === id)) fail(`${id}번 자리가 두 번 들어왔습니다.`);
    const row: AddedParticipant = {
      participant_id: id, team_id: team(x.team_id),
      streamer_id: normalizeCell("streamer_id", x.streamer_id) as string | null,
      observed_name: normalizeCell("observed_name", x.observed_name) as string | null,
      champion_id: normalizeCell("champion_id", x.champion_id) as number | null,
      team_position: normalizeCell("team_position", x.team_position) as string | null,
      kills: stat(x.kills, "킬"), deaths: stat(x.deaths, "데스"), assists: stat(x.assists, "어시스트"),
    };
    if (!row.streamer_id && !row.observed_name) fail(`${id}번 자리에 사람(스트리머 또는 화면 이름)을 적어 주세요.`);
    added.push(row);
  }
  if (added.length) out.add = added.sort((a, b) => a.participant_id - b.participant_id);
  return Object.keys(out).length ? out : null;
}

/** 이 제안이 건드리는 칸 주소(경기 칸 `match:<칸>`, 참가자 칸 `p<번호>:<칸>`, 자리 행 `p<번호>:*`). 같은 칸 다툼 판정에 쓴다. */
export function correctionCells(c: MatchCorrection): string[] {
  const cells: string[] = [];
  if (c.winning_team) cells.push("match:winning_team");
  for (const p of c.participants ?? []) for (const f of Object.keys(p.changes)) cells.push(`p${p.participant_id}:${f}`);
  for (const id of c.remove ?? []) cells.push(`p${id}:*`);
  for (const a of c.add ?? []) cells.push(`p${a.participant_id}:*`);
  return cells;
}

/** 두 칸 주소가 같은 칸인가 — 자리 행(*)은 그 자리의 모든 칸과 겹친다. */
export function cellsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [sa, fa] = a.split(":"), [sb, fb] = b.split(":");
  return sa === sb && sa !== "match" && (fa === "*" || fb === "*");
}

/** 지문의 재료 — 종류·대상·정규화한 제안을 키 순서까지 고정한 글자. 해시는 서버(db/submission.ts)가 한다. */
export function fingerprintSource(kind: SubmissionKind, target: string, payload: unknown): string {
  return JSON.stringify([kind, target, canonical(payload)]);
}

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) as T;
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
  return v;
}

/** 근거 링크 — http(s) 만, 길이 제한. 비우기는 null. */
export function normalizeEvidenceUrl(v: unknown): string | null {
  const t = String(v ?? "").trim();
  if (!t) return null;
  if (t.length > SUBMISSION_URL_MAX) fail(`근거 링크는 ${SUBMISSION_URL_MAX}자까지입니다.`);
  let u: URL;
  try { u = new URL(t); } catch { return fail("근거 링크가 주소 형식이 아닙니다."); }
  return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : fail("근거 링크는 http(s) 주소만 받습니다.");
}

export function normalizeNote(v: unknown): string | null {
  const t = String(v ?? "").trim();
  if (!t) return null;
  return t.length <= SUBMISSION_NOTE_MAX ? t : fail(`메모는 ${SUBMISSION_NOTE_MAX}자까지입니다.`);
}

const FIELD_LABEL: Record<CorrectionParticipantField, string> = {
  streamer_id: "스트리머", observed_name: "화면 이름", champion_id: "챔피언", team_position: "포지션", kills: "킬", deaths: "데스", assists: "어시스트",
};
const POSITION_NAME: Record<string, string> = { TOP: "탑", JUNGLE: "정글", MIDDLE: "미드", BOTTOM: "원딜", UTILITY: "서폿" };

/** 제안을 사람이 읽는 줄로 — 회원·운영자 화면이 같이 쓴다. 이름 풀이(스트리머·챔피언)는 부르는 쪽이 넘긴다. */
export function correctionLines(c: MatchCorrection, names: { streamer: (id: string) => string; champion: (id: number) => string }): string[] {
  const team = (t: unknown) => (t === 100 ? "블루" : t === 200 ? "레드" : "모름");
  const value = (f: CorrectionParticipantField, v: unknown): string => {
    if (v === null || v === undefined) return "비움";
    if (f === "streamer_id") return names.streamer(String(v));
    if (f === "champion_id") return names.champion(Number(v));
    if (f === "team_position") return POSITION_NAME[String(v)] ?? String(v);
    return String(v);
  };
  const lines: string[] = [];
  if (c.winning_team) lines.push(`승리 팀: ${team(c.winning_team.from)} → ${team(c.winning_team.to)}`);
  for (const p of c.participants ?? []) {
    for (const [f, ch] of Object.entries(p.changes) as [CorrectionParticipantField, CellChange<unknown>][]) {
      lines.push(`${p.participant_id}번 자리 ${FIELD_LABEL[f]}: ${value(f, ch.from)} → ${value(f, ch.to)}`);
    }
  }
  for (const id of c.remove ?? []) lines.push(`${id}번 자리 지우기`);
  for (const a of c.add ?? []) {
    const who = a.streamer_id ? names.streamer(a.streamer_id) : a.observed_name ?? "?";
    lines.push(`${a.participant_id}번 자리 더하기: ${team(a.team_id)} · ${who}${a.champion_id ? ` · ${names.champion(a.champion_id)}` : ""}`);
  }
  return lines;
}

// ── 편성표 제보(0094) ─────────────────────────────────────────────────────────
//
// 회원은 편성표를 **제보만** 한다 — 언제나 보류로 접수되고 운영자가 편성표 편집 폼으로 반영한다(사용자 결정 2026-10-17).
// 그래서 제안은 편성표 저장 입력(ScheduleInput)이 아니라 회원이 아는 만큼의 짧은 모양이다. 참가자는 이름 글자 그대로 —
// 운영자 폼이 등록된 스트리머와 맞춰 본다.

export const SCHEDULE_REPORT_STATUSES = ["scheduled", "cancelled", "postponed"] as const;
export type ScheduleReportStatus = (typeof SCHEDULE_REPORT_STATUSES)[number];
export const SCHEDULE_REPORT_STATUS_LABEL: Record<ScheduleReportStatus, string> = { scheduled: "예정대로", cancelled: "취소", postponed: "연기" };
export const SCHEDULE_REPORT_TITLE_MAX = 100;
export const SCHEDULE_REPORT_PEOPLE_MAX = 300;

export interface ScheduleReport {
  /** correction = 있는 일정 고치기 · new = 편성표에 없는 일정 알리기 */
  type: "correction" | "new";
  game_code?: ScheduleGame;
  title?: string;
  /** 고치기에서만 — 취소·연기·예정대로 */
  status?: ScheduleReportStatus;
  /** KST 날짜 YYYY-MM-DD */
  on_date?: string;
  /** KST "HH:MM". null = 시간 미정 */
  start?: string | null;
  /** 참가자 이름(쉼표·줄바꿈으로 나눈 글자를 정리한 것) */
  participants?: string;
}

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 참가자 이름 — 쉼표·줄바꿈으로 나눠 앞뒤 공백·빈 이름·같은 이름을 지우고 ", " 로 잇는다. */
export function normalizePeopleText(v: unknown): string | null {
  const names = [...new Set(String(v ?? "").split(/[,\n、·]/).map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (!names.length) return null;
  const out = names.join(", ");
  return out.length <= SCHEDULE_REPORT_PEOPLE_MAX ? out : fail(`참가자는 ${SCHEDULE_REPORT_PEOPLE_MAX}자까지입니다.`);
}

/**
 * 이름 글자 → 등록된 스트리머 slug. 표시 이름이나 slug 와 (대소문자만 무시하고) **정확히 같은 것만** 맞춘다 — 비슷한 이름을 추측하지 않는다
 * (틀린 사람을 일정에 넣느니 운영자에게 이름으로 보여 준다). 같은 사람을 두 번 적으면 한 번.
 */
export function matchStreamerNames(text: string, streamers: readonly { slug: string; display_name: string }[]): { slugs: string[]; unmatched: string[] } {
  const byName = new Map<string, string>();
  for (const s of streamers) { byName.set(s.slug.toLowerCase(), s.slug); byName.set(s.display_name.toLowerCase(), s.slug); }
  const slugs: string[] = [], unmatched: string[] = [];
  for (const name of (normalizePeopleText(text) ?? "").split(", ").filter(Boolean)) {
    const slug = byName.get(name.toLowerCase());
    if (!slug) unmatched.push(name);
    else if (!slugs.includes(slug)) slugs.push(slug);
  }
  return { slugs, unmatched };
}

/**
 * 편성표 제보 정규화 — 빈 칸을 지우고 형식을 확인한다. 새 일정은 게임·제목·날짜가 있어야 한다(근거 링크는 db 쪽이 확인).
 * 고치기에서 남는 칸이 없으면 빈 고치기({type})다 — 메모만 있는 고치기는 db 쪽이 받는다.
 */
export function normalizeScheduleReport(raw: unknown): ScheduleReport {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = r.type === "new" ? "new" : r.type === "correction" ? "correction" : fail("제보 종류가 올바르지 않습니다.");
  const out: ScheduleReport = { type };
  if (r.game_code !== undefined && r.game_code !== null && r.game_code !== "") {
    if (!SCHEDULE_GAMES.includes(r.game_code as ScheduleGame)) fail("게임은 LOL·FC 온라인 중 하나입니다.");
    out.game_code = r.game_code as ScheduleGame;
  }
  const title = String(r.title ?? "").trim().replace(/\s+/g, " ");
  if (title) out.title = title.length <= SCHEDULE_REPORT_TITLE_MAX ? title : fail(`제목은 ${SCHEDULE_REPORT_TITLE_MAX}자까지입니다.`);
  if (r.status !== undefined && r.status !== null && r.status !== "") {
    if (type === "new") fail("새 일정에는 상태를 고를 수 없습니다.");
    if (!SCHEDULE_REPORT_STATUSES.includes(r.status as ScheduleReportStatus)) fail("상태가 올바르지 않습니다.");
    out.status = r.status as ScheduleReportStatus;
  }
  const date = String(r.on_date ?? "").trim();
  if (date) out.on_date = validDate(date) ? date : fail(`없는 날짜입니다: ${date}`);
  if (r.start !== undefined) {
    const t = String(r.start ?? "").trim();
    if (!t) out.start = null;
    else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) out.start = t;
    else fail("시작 시각은 HH:MM 으로 써 주세요.");
    if (!out.on_date) fail("시작 시각을 고치려면 날짜도 함께 써 주세요.");
  }
  const people = normalizePeopleText(r.participants);
  if (people) out.participants = people;
  if (type === "new") {
    if (!out.game_code) fail("게임을 골라 주세요.");
    if (!out.title) fail("제목을 써 주세요.");
    if (!out.on_date) fail("날짜를 써 주세요.");
  }
  return out;
}

/** 고칠 칸이 있나(새 일정은 언제나 있다). */
export const scheduleReportHasChange = (r: ScheduleReport): boolean =>
  r.type === "new" || Object.keys(r).some((k) => k !== "type");

/** 편성표 제보를 사람이 읽는 줄로 — 회원·운영자 화면이 같이 쓴다. */
export function scheduleReportLines(r: ScheduleReport): string[] {
  const lines: string[] = [r.type === "new" ? "편성표에 없는 일정" : "일정 고치기"];
  if (r.game_code) lines.push(`게임: ${SCHEDULE_GAME_LABEL[r.game_code]}`);
  if (r.title) lines.push(`제목: ${r.title}`);
  if (r.status) lines.push(`상태: ${SCHEDULE_REPORT_STATUS_LABEL[r.status]}`);
  if (r.on_date) lines.push(`날짜: ${r.on_date}${r.start ? ` ${r.start}` : r.start === null ? " (시간 미정)" : ""}`);
  if (r.participants) lines.push(`참가자: ${r.participants}`);
  return lines;
}

/** 종류와 제안 — kind 로 갈리는 판별 합집합(잘못된 조합은 컴파일러가 잡는다). 제보 행(db/submission.ts)이 이것을 품는다. */
export type SubmissionContent =
  | { kind: "match_correction"; payload: MatchCorrection }
  | { kind: "schedule_report"; payload: ScheduleReport };

/** 제보 하나를 읽는 줄로 — 종류에 맞는 풀이를 고른다. 목록 화면(내 제보·운영자 대기열)이 종류를 따지지 않게 한 곳에서. */
export function submissionLines(s: SubmissionContent, names: { streamer: (id: string) => string; champion: (id: number) => string }): string[] {
  return s.kind === "schedule_report" ? scheduleReportLines(s.payload) : correctionLines(s.payload, names);
}
