/**
 * 빠진 경기 직접 입력(0099 match_addition)의 **순수 규칙** — 정규화·이름표·사람·날짜 중복 규칙. DB 를 모른다.
 * 설계: docs/SUBMISSION-POLICY-PLAN.md §7 가. 쓰기·공개·판독 잇기는 db/submission.ts(어댑터 match_addition).
 *
 * ★ 회원이 아는 것만 받는다 — 두 팀 사람, 세트마다 A팀 진영·승리 팀, (선택) 사람마다 챔피언·KDA. 포지션·경기 시간은 판독이 채운다.
 *   시각은 회원의 어림이라 날짜 정확도('date')로 저장한다(세트 시각은 시작 + 40분씩 — 판독 후보 조회가 방송 안에서 찾게 하는 자리일 뿐).
 * ★ 중복은 사람·날짜로 본다(챔피언·KDA 가 없을 수 있다) — 같은 KST 날짜에 같은 편 사람이 N명 넘게 겹치는 공개 내전 세트가 있으면 같은 판 후보다.
 *   저장 중복 판정(ck-duplicate.ts, 챔피언·KDA 기준)과는 다른 질문이다: "이미 기록된 시리즈를 또 등록하나".
 */
import { championById } from "../riot/champions.ts";
import { SubmissionInputError } from "./submission-errors.ts";

export const ADDITION_TEAM_MAX = 5;
export const ADDITION_SETS_MAX = 7;
/** 등록된 스트리머가 이 수보다 적으면 받지 않는다 — 스트리머끼리 내전만 기록한다(사이트 목적). */
export const ADDITION_STREAMERS_MIN = 2;
/** 같은 편으로 겹치는 등록 스트리머가 이 수 이상이면 같은 시리즈 후보(등록 수가 더 적으면 그 수 전부). */
export const ADDITION_OVERLAP_MIN = 3;
/** 세트 시각 어림 간격(분). */
export const ADDITION_SET_GAP_MIN = 40;

export type AdditionTeam = "a" | "b";
/** 사람 하나 — 등록된 스트리머(streamer_id) 또는 화면 이름(name). */
export type AdditionPerson = { streamer_id: string } | { name: string };
export interface AdditionStat { champion_id?: number; kills?: number; deaths?: number; assists?: number }
export interface AdditionSet {
  /** A팀이 블루(100)였나 레드(200)였나. */
  a_side: 100 | 200;
  winner: AdditionTeam;
  /** 사람 자리(`a0`~`a4`, `b0`~`b4`)마다의 선택 값. */
  stats?: Record<string, AdditionStat>;
}
export interface MatchAddition {
  /** 고른 행사. null = 행사 모름(그날의 회원 등록 미분류 묶음에 둔다 — 이름은 운영자·판독이 정한다). */
  event_id: string | null;
  on_date: string;
  /** 첫 세트 시작 어림(KST HH:MM). */
  start: string;
  map: "rift" | "aram";
  /** VOD 링크를 줬으면 그 번호(선택 — 없으면 그날 참가자들의 VOD 를 찾는다). */
  vod?: number;
  teams: { a: AdditionPerson[]; b: AdditionPerson[] };
  sets: AdditionSet[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (m: string): never => { throw new SubmissionInputError(m); };

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function person(raw: unknown): AdditionPerson | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = String(r.streamer_id ?? "").trim();
  if (id) return UUID.test(id) ? { streamer_id: id.toLowerCase() } : fail("고른 스트리머가 올바르지 않습니다.");
  const name = String(r.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return null;
  return name.length <= 30 ? { name } : fail("이름은 30자까지입니다.");
}

const statNum = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : fail(`${what}는 0~99 사이 숫자입니다.`);
};

/** 정규화 — 빈 자리를 지우고 형식을 확인한다. 같은 뜻이면 같은 모양(지문의 바탕). VOD 번호는 호출자가 링크에서 읽어 넣는다. */
export function normalizeMatchAddition(raw: unknown, vod: number | null): MatchAddition {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const eventId = String(r.event_id ?? "").trim();
  if (eventId && !UUID.test(eventId)) fail("고른 행사가 올바르지 않습니다.");
  const on_date = String(r.on_date ?? "").trim();
  if (!validDate(on_date)) fail("날짜를 골라 주세요.");
  const start = String(r.start ?? "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) fail("시작 시각(어림)을 HH:MM 으로 써 주세요.");
  const map = r.map === "aram" ? "aram" : r.map === "rift" || r.map === undefined ? "rift" : fail("맵이 올바르지 않습니다.");
  const teamOf = (k: AdditionTeam) => {
    const list = (Array.isArray((r.teams as Record<string, unknown> | undefined)?.[k]) ? (r.teams as Record<string, unknown[]>)[k] : [])
      .map(person).filter((p): p is AdditionPerson => p !== null);
    if (!list.length) fail(`${k === "a" ? "A" : "B"}팀 사람을 한 명 이상 써 주세요.`);
    if (list.length > ADDITION_TEAM_MAX) fail(`한 팀은 ${ADDITION_TEAM_MAX}명까지입니다.`);
    return list;
  };
  const teams = { a: teamOf("a"), b: teamOf("b") };
  const keys = [...teams.a, ...teams.b].map((p) => ("streamer_id" in p ? `s:${p.streamer_id}` : `n:${p.name.toLowerCase()}`));
  if (new Set(keys).size !== keys.length) fail("같은 사람을 두 번 넣었습니다.");
  if (keys.filter((k) => k.startsWith("s:")).length < ADDITION_STREAMERS_MIN) fail(`등록된 스트리머를 ${ADDITION_STREAMERS_MIN}명 이상 골라 주세요.`);
  const rawSets = Array.isArray(r.sets) ? r.sets : [];
  if (!rawSets.length) fail("세트를 하나 이상 써 주세요.");
  if (rawSets.length > ADDITION_SETS_MAX) fail(`세트는 ${ADDITION_SETS_MAX}개까지입니다.`);
  const slots = new Set([...teams.a.map((_, i) => `a${i}`), ...teams.b.map((_, i) => `b${i}`)]);
  const sets = rawSets.map((x, n): AdditionSet => {
    const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const a_side = Number(s.a_side) === 200 ? 200 : Number(s.a_side) === 100 ? 100 : fail(`${n + 1}세트의 A팀 진영을 골라 주세요.`);
    const winner = s.winner === "a" || s.winner === "b" ? s.winner : fail(`${n + 1}세트의 승리 팀을 골라 주세요.`);
    const stats: Record<string, AdditionStat> = {};
    for (const [slot, v] of Object.entries((s.stats && typeof s.stats === "object" ? s.stats : {}) as Record<string, Record<string, unknown>>)) {
      if (!slots.has(slot)) continue;   // 지운 사람의 칸
      const st: AdditionStat = {};
      const rawChamp = v?.champion_id;
      if (rawChamp !== undefined && rawChamp !== null && rawChamp !== "" && Number(rawChamp) !== 0) {
        const champ = Number(rawChamp);
        if (!Number.isInteger(champ) || !championById(champ)) fail(`${n + 1}세트: 없는 챔피언입니다.`);
        st.champion_id = champ;
      }
      for (const f of ["kills", "deaths", "assists"] as const) {
        const k = statNum(v?.[f], "KDA");
        if (k !== undefined) st[f] = k;
      }
      if (Object.keys(st).length) stats[slot] = st;
    }
    return Object.keys(stats).length ? { a_side, winner, stats: Object.fromEntries(Object.entries(stats).sort()) } : { a_side, winner };
  });
  const out: MatchAddition = { event_id: eventId ? eventId.toLowerCase() : null, on_date, start, map, teams, sets };
  if (vod) out.vod = vod;
  return out;
}

/** 등록된 스트리머 — 팀별. 중복 규칙과 판독 요청이 쓴다. */
export const additionStreamers = (a: MatchAddition) => ({
  a: a.teams.a.flatMap((p) => ("streamer_id" in p ? [p.streamer_id] : [])),
  b: a.teams.b.flatMap((p) => ("streamer_id" in p ? [p.streamer_id] : [])),
});

/** 세트 i(0부터)의 시각 어림 — KST 날짜 + 시작 + 40분씩. 날짜 정확도로 저장한다. */
export function additionSetTime(a: MatchAddition, i: number): Date {
  return new Date(new Date(`${a.on_date}T${a.start}:00+09:00`).getTime() + i * ADDITION_SET_GAP_MIN * 60_000);
}

/**
 * 같은 시리즈 후보인가 — 이미 있는 세트 하나(팀 100·200 의 사람)와 회원 입력(A·B 팀)을 두 짝(A=100·B=200 또는 반대)으로 대 보고
 * 같은 편으로 겹치는 등록 스트리머 수의 큰 쪽이 기준 이상이면 후보. 기준 = min(ADDITION_OVERLAP_MIN, 회원이 고른 등록 스트리머 수).
 */
export function additionOverlap(mine: { a: readonly string[]; b: readonly string[] }, set: { 100: readonly string[]; 200: readonly string[] }): number {
  const hit = (x: readonly string[], y: readonly string[]) => x.filter((p) => y.includes(p)).length;
  return Math.max(hit(mine.a, set[100]) + hit(mine.b, set[200]), hit(mine.a, set[200]) + hit(mine.b, set[100]));
}
export function isSameSeriesCandidate(mine: { a: readonly string[]; b: readonly string[] }, set: { 100: readonly string[]; 200: readonly string[] }): boolean {
  const need = Math.min(ADDITION_OVERLAP_MIN, mine.a.length + mine.b.length);
  return need >= ADDITION_STREAMERS_MIN && additionOverlap(mine, set) >= need;
}

/** 읽는 줄 — 회원·운영자 화면이 같이 쓴다. */
export function additionLines(a: MatchAddition, names: { streamer: (id: string) => string; champion: (id: number) => string; event?: (id: string) => string }): string[] {
  const who = (p: AdditionPerson) => ("streamer_id" in p ? names.streamer(p.streamer_id) : `${p.name}(이름만)`);
  const lines = [
    `빠진 경기 등록 · ${a.on_date} ${a.start} 무렵 · ${a.map === "aram" ? "칼바람" : "협곡"}`,
    `행사: ${a.event_id ? names.event?.(a.event_id) ?? "고른 행사" : "모름"}`,
    `A팀: ${a.teams.a.map(who).join(", ")}`,
    `B팀: ${a.teams.b.map(who).join(", ")}`,
  ];
  a.sets.forEach((s, i) => {
    const stats = Object.entries(s.stats ?? {}).map(([slot, st]) => {
      const p = (slot[0] === "a" ? a.teams.a : a.teams.b)[Number(slot.slice(1))];
      const kda = st.kills !== undefined || st.deaths !== undefined || st.assists !== undefined ? ` ${st.kills ?? "?"}/${st.deaths ?? "?"}/${st.assists ?? "?"}` : "";
      return `${p ? who(p) : slot}${st.champion_id ? ` ${names.champion(st.champion_id)}` : ""}${kda}`;
    });
    lines.push(`${i + 1}세트: A팀 ${s.a_side === 100 ? "블루" : "레드"} · ${s.winner === "a" ? "A팀" : "B팀"} 승${stats.length ? ` · ${stats.join(", ")}` : ""}`);
  });
  if (a.vod) lines.push(`VOD ${a.vod}`);
  return lines;
}
