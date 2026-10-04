/**
 * 대진 시드 파일(seed/brackets/<대회 slug>.json)의 모양과 해석.
 * 사람이 손으로 쓰고 읽는 형식이라 화살표를 칸 안에 짧게 적는다:
 *   "winner": "5a"      → 5경기 a 자리     ("2:5a" 처럼 단계 번호를 붙이면 다른 단계의 칸)
 *   "loser":  "rank:8"  → 8위 확정          ("rank:3-4" 는 공동 3–4위)
 *   "loser":  "out"     → 탈락(순위 모름)
 *   selection 칸으로 갈 때는 자리 글자 없이 "7" 처럼 쓴다.
 * 저장 스크립트(scripts/bracket-apply.ts)와 테스트가 같은 해석을 쓴다 — 두 벌이면 어긋난다.
 */
import type { BracketRoute, BracketSlot, DecisionBasis, DecisionStatus, FinalRank, RouteTarget, SlotDecision } from "./bracket.ts";

export interface BracketSpecSlot {
  no: number;
  label?: string | null;
  lane?: string | null;
  kind?: "match" | "selection";
  bestOf?: number | null;
  picks?: number | null;
  /** 참가 단위 key */
  seedA?: string | null;
  seedB?: string | null;
  winner: string;
  loser: string;
  /** 이 칸에 이어지는 실제 경기의 match_id */
  matches?: string[];
  evidence?: string;
}

export interface BracketSpec {
  event: string;
  game: "lol" | "fconline";
  /** 기본 근거. 칸·결정마다 따로 적으면 그것이 우선한다 */
  evidence: string;
  stages: { no: number; name: string; template?: string | null; evidence?: string; slots: BracketSpecSlot[] }[];
  /** 참가 단위. key 는 이 파일 안의 이름일 뿐이고 DB 에선 event_team id 로 바뀐다 */
  entrants: { key: string; name: string; streamers: string[] }[];
  decisions?: { slot: number | string; status: DecisionStatus; winners?: string[]; scoreA?: number | null; scoreB?: number | null; basis: DecisionBasis; evidence: string }[];
  finalRanks?: { entrant: string; min: number; max: number; basis: FinalRank["basis"]; evidence: string }[];
}

export const specSlotId = (stageNo: number, no: number) => `${stageNo}:${no}`;

/** "5" → 같은 단계 5경기, "2:5" → 2단계 5경기 */
function slotRef(stageNo: number, ref: string | number): string {
  const text = String(ref);
  const [stage, no] = text.includes(":") ? text.split(":") : [String(stageNo), text];
  if (!/^\d+$/.test(stage) || !/^\d+$/.test(no)) throw new Error(`칸 참조를 읽을 수 없다: ${text}`);
  return specSlotId(Number(stage), Number(no));
}

export function parseTarget(stageNo: number, text: string): RouteTarget {
  if (text === "out") return { kind: "eliminated" };
  const rank = /^rank:(\d+)(?:-(\d+))?$/.exec(text);
  if (rank) return { kind: "placement", min: Number(rank[1]), max: Number(rank[2] ?? rank[1]) };
  const slot = /^((?:\d+:)?\d+)([ab])?$/.exec(text);
  if (!slot) throw new Error(`화살표를 읽을 수 없다: ${text} (예: "5a", "rank:3-4", "out")`);
  return { kind: "slot", slot: slotRef(stageNo, slot[1]), side: (slot[2] as "a" | "b" | undefined) ?? null };
}

export interface ParsedSpec {
  slots: BracketSlot[];
  routes: BracketRoute[];
  /** 칸 id → match_id 목록 */
  links: Map<string, string[]>;
  decisions: SlotDecision[];
  finalRanks: FinalRank[];
  evidence: Map<string, string>;
}

/** 참가 단위는 key 그대로 둔다(DB 에선 저장 함수가 event_team id 로 바꾼다). */
export function parseBracketSpec(spec: BracketSpec): ParsedSpec {
  const keys = new Set(spec.entrants.map((e) => e.key));
  const entrant = (key: string | null | undefined, where: string) => {
    if (key == null) return null;
    if (!keys.has(key)) throw new Error(`${where}: 참가 단위 목록에 없는 key — ${key}`);
    return key;
  };
  const slots: BracketSlot[] = [];
  const routes: BracketRoute[] = [];
  const links = new Map<string, string[]>();
  const evidence = new Map<string, string>();
  for (const stage of spec.stages) for (const s of stage.slots) {
    const id = specSlotId(stage.no, s.no);
    slots.push({
      id, stageNo: stage.no, no: s.no, label: s.label ?? null, lane: s.lane ?? null, kind: s.kind ?? "match",
      bestOf: s.bestOf ?? null, picks: s.picks ?? null,
      seedA: entrant(s.seedA, `${id} seedA`), seedB: entrant(s.seedB, `${id} seedB`),
    });
    routes.push({ fromSlot: id, outcome: "winner", to: parseTarget(stage.no, s.winner) });
    routes.push({ fromSlot: id, outcome: "loser", to: parseTarget(stage.no, s.loser) });
    if (s.matches?.length) links.set(id, s.matches);
    evidence.set(id, s.evidence ?? stage.evidence ?? spec.evidence);
  }
  const firstStage = spec.stages[0]?.no ?? 1;
  const decisions: SlotDecision[] = (spec.decisions ?? []).map((d) => ({
    slotId: slotRef(firstStage, d.slot), status: d.status,
    winners: (d.winners ?? []).map((w) => entrant(w, `결정 ${d.slot}`)!),
    scoreA: d.scoreA ?? null, scoreB: d.scoreB ?? null, basis: d.basis, evidence: d.evidence,
  }));
  const finalRanks: FinalRank[] = (spec.finalRanks ?? []).map((f) => ({
    entrant: entrant(f.entrant, "최종 순위")!, min: f.min, max: f.max, basis: f.basis,
  }));
  return { slots, routes, links, decisions, finalRanks, evidence };
}
