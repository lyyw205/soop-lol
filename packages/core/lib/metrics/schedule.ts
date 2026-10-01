/**
 * 편성표의 시간 규칙 — 공개 화면·관리자·(나중의) ICS 가 같은 함수를 쓴다(원칙 6). docs/SCHEDULE-PLAN.md §1·§2
 *
 * ★ 시간이 지난 것과 실제로 열린 것은 다르다
 *   "지난 일정" 은 시각으로 계산하고, "개최 확인" 은 사람이 status='held' 로 확인한 것만이다.
 *   실제 방송 상태를 보지 않으므로 LIVE 라고 쓰지 않는다 — "공지상 진행 시간" 이다.
 * ★ 시각 미정(날짜만 앎)은 진행 판정을 하지 않는다. 종료 미정은 "진행 시간" 을 말하지 않는다.
 */

import { fromKstInputValue, KST_OFFSET_MS, kstDateString } from "../time.ts";

export type ScheduleStatus = "scheduled" | "held" | "cancelled";
export type ScheduleScale = "major" | "minor";
export type SchedulePlannedKind = "tournament" | "showmatch" | "ck" | "other";
export type ScheduleRole = "host" | "player" | "caster";
export type ScheduleGame = "lol" | "fconline";

export const SCHEDULE_GAMES: readonly ScheduleGame[] = ["lol", "fconline"];
export const SCHEDULE_SCALES: readonly ScheduleScale[] = ["major", "minor"];
export const SCHEDULE_KINDS: readonly SchedulePlannedKind[] = ["tournament", "showmatch", "ck", "other"];
export const SCHEDULE_STATUSES: readonly ScheduleStatus[] = ["scheduled", "held", "cancelled"];
export const SCHEDULE_ROLES: readonly ScheduleRole[] = ["host", "player", "caster"];

export const SCHEDULE_SCALE_LABEL: Record<ScheduleScale, string> = { major: "대형", minor: "소형" };
export const SCHEDULE_KIND_LABEL: Record<SchedulePlannedKind, string> = { tournament: "대회", showmatch: "이벤트전", ck: "CK", other: "기타" };
export const SCHEDULE_ROLE_LABEL: Record<ScheduleRole, string> = { host: "주최", player: "선수", caster: "해설" };
export const SCHEDULE_GAME_LABEL: Record<ScheduleGame, string> = { lol: "LOL", fconline: "FC 온라인" };

// ── 날짜 (KST 달력 날짜 'YYYY-MM-DD') ────────────────────────────────

/** 그 KST 날짜가 시작하는 순간. 달력에 없는 날짜면 null. */
export function kstDayStart(date: string): Date | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? fromKstInputValue(`${date}T00:00`) : null;
}

/** 날짜 문자열에 n일을 더한다. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** b - a (일). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 그 순간의 KST 시:분. */
export const kstClock = (at: Date): string => new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(11, 16);

// ── 칸 하나의 시각 ───────────────────────────────────────────────────

export interface SlotTime {
  on_date: string;
  starts_at: Date | null;
  ends_at: Date | null;
}

/**
 * upcoming  — 아직 시작 전(시각 미정이면 그날이 끝나기 전까지 전부 여기다 — 진행 판정을 하지 않는다)
 * in_window — 공지상 진행 시간 안(시작·끝을 둘 다 알 때만)
 * started   — 시작은 지났는데 끝을 모른다. 그날(KST)이 끝나기 전까지
 * past      — 끝이 지났다. 끝을 모르면 그날이 끝났다
 */
export type SlotPhase = "upcoming" | "in_window" | "started" | "past";

export function slotPhase(slot: SlotTime, now: Date): SlotPhase {
  const dayEnd = kstDayStart(addDays(slot.on_date, 1));
  const t = now.getTime();
  if (slot.ends_at) {
    if (t >= slot.ends_at.getTime()) return "past";
    return slot.starts_at && t >= slot.starts_at.getTime() ? "in_window" : "upcoming";
  }
  if (dayEnd && t >= dayEnd.getTime()) return "past";
  if (slot.starts_at && t >= slot.starts_at.getTime()) return "started";
  return "upcoming";
}

// ── 일정 하나의 상태 ─────────────────────────────────────────────────

export type EntryState = "cancelled" | "upcoming" | "in_window" | "started" | "past_unconfirmed" | "held";

export const ENTRY_STATE_LABEL: Record<EntryState, string> = {
  cancelled: "무산",
  upcoming: "예정",
  in_window: "공지상 진행 시간",
  started: "공지상 시작",
  past_unconfirmed: "지난 일정 · 개최 미확인",
  held: "개최 확인",
};

/**
 * 표시 상태. 저장된 status 와 지금 시각에서 계산한다 — "진행 중"·"지난 일정" 을 저장하면 매일 누가 바꿔야 한다.
 * ★ 지난 일정이어도 사람이 held 로 확인하기 전에는 "개최 확인" 이 아니다(대형도 마찬가지).
 */
export function entryState(status: ScheduleStatus, slots: SlotTime[], now: Date): EntryState {
  if (status === "cancelled") return "cancelled";
  const phases = slots.map((s) => slotPhase(s, now));
  if (phases.includes("in_window")) return "in_window";
  if (phases.includes("started")) return "started";
  if (phases.length > 0 && phases.every((p) => p === "past")) return status === "held" ? "held" : "past_unconfirmed";
  return "upcoming";
}

/** 칸 하나의 시각 문구. "20:00–23:00" · "20:00 시작" · "시각 미정". */
export function slotTimeLabel(slot: SlotTime): string {
  if (!slot.starts_at) return "시각 미정";
  if (!slot.ends_at) return `${kstClock(slot.starts_at)} 시작`;
  return `${kstClock(slot.starts_at)}–${kstClock(slot.ends_at)}`;
}

/** 행사 기간(대형 막대). 저장하지 않고 칸 날짜의 최소~최대로 계산한다. */
export function entryPeriod(slots: { on_date: string }[]): { from: string; to: string } | null {
  if (slots.length === 0) return null;
  const dates = slots.map((s) => s.on_date).sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

// ── 방송 채널 ────────────────────────────────────────────────────────

/**
 * 1) 칸에 명시한 채널  2) 주최가 정확히 한 명이고 그 사람의 활성 SOOP 채널이 정확히 하나면 그것  3) 그 밖엔 null.
 * 추측하지 않는다 — 주최가 둘이거나 채널이 둘이면 어느 쪽인지 모른다.
 */
export function pickBroadcastChannel(slotChannel: string | null, hosts: { channels: string[] }[]): string | null {
  if (slotChannel) return slotChannel;
  if (hosts.length !== 1) return null;
  return hosts[0].channels.length === 1 ? hosts[0].channels[0] : null;
}

// ── 입력 ─────────────────────────────────────────────────────────────

/**
 * 관리자 입력(날짜 + "HH:MM")을 시각으로 바꾼다.
 * ★ 끝 시각이 시작보다 이르거나 같으면 **다음 날**로 본다(20:00–01:00 같은 밤샘 방송).
 * ★ 달력에 없는 날짜·시각은 넘기지 않고 오류다(fromKstInputValue 가 2026-02-30 을 null 로 돌려준다).
 */
export function buildSlotTimes(onDate: string, start: string, end: string):
  { ok: true; starts_at: Date | null; ends_at: Date | null } | { ok: false; error: string } {
  if (!kstDayStart(onDate)) return { ok: false, error: `없는 날짜입니다: ${onDate || "(빈칸)"}` };
  if (!start) return end ? { ok: false, error: `${onDate}: 시작 시각 없이 끝 시각만 적을 수 없습니다` } : { ok: true, starts_at: null, ends_at: null };
  const startsAt = /^\d{2}:\d{2}$/.test(start) ? fromKstInputValue(`${onDate}T${start}`) : null;
  if (!startsAt) return { ok: false, error: `${onDate}: 없는 시각입니다 — ${start}` };
  if (!end) return { ok: true, starts_at: startsAt, ends_at: null };
  let endsAt = /^\d{2}:\d{2}$/.test(end) ? fromKstInputValue(`${onDate}T${end}`) : null;
  if (!endsAt) return { ok: false, error: `${onDate}: 없는 시각입니다 — ${end}` };
  if (endsAt.getTime() <= startsAt.getTime()) endsAt = new Date(endsAt.getTime() + 86_400_000);
  return { ok: true, starts_at: startsAt, ends_at: endsAt };
}

export interface ScheduleSlotInput extends SlotTime {
  label: string | null;
  channel_id: string | null;
}

export interface ScheduleInput {
  game_code: ScheduleGame;
  title: string;
  scale: ScheduleScale;
  planned_kind: SchedulePlannedKind;
  sponsor: string | null;
  description: string | null;
  admin_note: string | null;
  status: ScheduleStatus;
  event_id: string | null;
  visibility: "public" | "hidden";
  slots: ScheduleSlotInput[];
  participants: { streamer_id: string; role: ScheduleRole; team: string | null }[];
  sources: { url: string; title: string | null; posted_at: Date | null }[];
}

/**
 * 표 하나만 보고 알 수 있는 검증. DB 를 봐야 하는 것(결과 event 의 게임·동시 수정)은 접근자가 트랜잭션 안에서 본다.
 * 오류 문구 목록을 돌려준다 — 비면 통과.
 */
export function validateScheduleInput(input: ScheduleInput): string[] {
  const errors: string[] = [];
  if (!SCHEDULE_GAMES.includes(input.game_code)) errors.push("게임은 LOL·FC 온라인 중 하나입니다.");
  if (!input.title.trim()) errors.push("제목이 비어 있습니다.");
  if (!SCHEDULE_SCALES.includes(input.scale)) errors.push("규모는 대형·소형 중 하나입니다.");
  if (!SCHEDULE_KINDS.includes(input.planned_kind)) errors.push("분류가 올바르지 않습니다.");
  if (!SCHEDULE_STATUSES.includes(input.status)) errors.push("상태가 올바르지 않습니다.");
  if (input.slots.length === 0) errors.push("방송 칸이 하나 이상 있어야 합니다.");
  for (const s of input.slots) {
    if (!kstDayStart(s.on_date)) { errors.push(`없는 날짜입니다: ${s.on_date}`); continue; }
    if (s.starts_at && kstDateString(s.starts_at) !== s.on_date) errors.push(`${s.on_date}: 시작 시각의 날짜가 칸 날짜와 다릅니다.`);
    if (s.ends_at && !s.starts_at) errors.push(`${s.on_date}: 시작 시각 없이 끝 시각만 둘 수 없습니다.`);
    if (s.ends_at && s.starts_at && s.ends_at.getTime() <= s.starts_at.getTime()) errors.push(`${s.on_date}: 끝 시각이 시작보다 늦어야 합니다.`);
  }
  if (input.visibility === "public" && input.sources.length === 0) errors.push("공개하려면 근거 공지(출처)가 하나 이상 있어야 합니다.");
  for (const src of input.sources) if (!/^https?:\/\/\S+$/.test(src.url)) errors.push(`출처 주소가 올바르지 않습니다: ${src.url}`);
  if (new Set(input.sources.map((s) => s.url)).size !== input.sources.length) errors.push("같은 출처 주소가 두 번 있습니다.");
  const roles = input.participants.map((p) => `${p.streamer_id}:${p.role}`);
  if (new Set(roles).size !== roles.length) errors.push("같은 스트리머가 같은 역할로 두 번 있습니다.");
  if (input.participants.some((p) => !SCHEDULE_ROLES.includes(p.role))) errors.push("참가자 역할이 올바르지 않습니다.");
  if (input.event_id && input.status !== "held") errors.push("결과 경기를 연결하려면 상태가 '개최 확인' 이어야 합니다.");
  return errors;
}


// ── 변경 이력 ────────────────────────────────────────────────────────
//
// 공개 화면이 보여 주는 의미 있는 변화만 — 제목·상태·방송 칸(날짜·시각·단계). 관리자 메모·공개 여부는 아니다.
// 저장 형태는 사람이 읽을 수 있는 요약(KST "HH:MM")이다 — 화면이 그대로 문장으로 만든다.

export type ScheduleChangeField = "title" | "status" | "slots";
export interface SlotSummary { on_date: string; start: string | null; end: string | null; label: string | null }
export interface ScheduleChange { field: ScheduleChangeField; before: unknown; after: unknown }

export const STATUS_CHANGE_LABEL: Record<ScheduleStatus, string> = { scheduled: "예정", held: "개최 확인", cancelled: "무산" };

/** 칸 목록의 비교용 요약. 순서는 날짜·시각순으로 맞춘다(입력 순서가 달라도 같은 일정이면 같다). */
export function slotSummary(slots: (SlotTime & { label: string | null })[]): SlotSummary[] {
  return slots
    .map((s) => ({ on_date: s.on_date, start: s.starts_at ? kstClock(s.starts_at) : null, end: s.ends_at ? kstClock(s.ends_at) : null, label: s.label ?? null }))
    .sort((a, b) => a.on_date.localeCompare(b.on_date) || (a.start ?? "99").localeCompare(b.start ?? "99") || (a.label ?? "").localeCompare(b.label ?? ""));
}

/** 이전 값 → 새 값. 같으면 빈 배열. */
export function scheduleChanges(
  prev: { title: string; status: ScheduleStatus; slots: SlotSummary[] },
  next: { title: string; status: ScheduleStatus; slots: SlotSummary[] },
): ScheduleChange[] {
  const out: ScheduleChange[] = [];
  if (prev.title.trim() !== next.title.trim()) out.push({ field: "title", before: prev.title.trim(), after: next.title.trim() });
  if (prev.status !== next.status) out.push({ field: "status", before: prev.status, after: next.status });
  if (JSON.stringify(prev.slots) !== JSON.stringify(next.slots)) out.push({ field: "slots", before: prev.slots, after: next.slots });
  return out;
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
function slotText(s: SlotSummary): string {
  const time = !s.start ? "시각 미정" : s.end ? `${s.start}–${s.end}` : `${s.start} 시작`;
  return `${shortDate(s.on_date)} ${time}${s.label ? ` (${s.label})` : ""}`;
}

/**
 * 이력 한 줄을 문장으로. 칸은 빠진 것과 생긴 것만 말한다 — 그대로인 칸까지 늘어놓으면 무엇이 바뀌었는지 안 보인다.
 * 하나가 빠지고 하나가 생기면 "A → B" 로 잇는다(연기·시각 변경의 흔한 모양).
 */
export function describeChange(c: ScheduleChange): string {
  if (c.field === "title") return `제목 변경: ${c.before} → ${c.after}`;
  if (c.field === "status") return `${STATUS_CHANGE_LABEL[c.before as ScheduleStatus]} → ${STATUS_CHANGE_LABEL[c.after as ScheduleStatus]}`;
  const before = c.before as SlotSummary[];
  const after = c.after as SlotSummary[];
  const key = (s: SlotSummary) => JSON.stringify(s);
  const gone = before.filter((b) => !after.some((a) => key(a) === key(b)));
  const added = after.filter((a) => !before.some((b) => key(a) === key(b)));
  if (gone.length === 1 && added.length === 1) return `일정 변경: ${slotText(gone[0])} → ${slotText(added[0])}`;
  const parts = [...gone.map((s) => `${slotText(s)} 빠짐`), ...added.map((s) => `${slotText(s)} 추가`)];
  return `일정 변경: ${parts.join(" · ")}`;
}
