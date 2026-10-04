/**
 * 대진(bracket) 계산 엔진. 롤·FC 공통. docs/TOURNAMENT-FORMAT-PLAN.md
 *
 * 대회를 **칸**과 **화살표**로 본다.
 *   칸   = 참가 단위가 들어와 승자 쪽과 패자 쪽으로 갈리는 자리.
 *          'match' 는 경기로 가르고(두 자리 a/b), 'selection' 은 주최측 선택(투표·지명)으로 가른다.
 *   화살표 = 칸의 승자/패자가 가는 곳 — 다음 칸의 자리 / 순위 확정(범위) / 탈락(순위 모름).
 * 형식(토너먼트·더블 엘리미네이션)은 칸과 화살표를 만들어 주는 도우미(templates.ts)일 뿐이다.
 *
 * ★ 실제 경기 결과와 대회가 채택한 결과를 나눈다. 채택 결과 = 최신 결정(decision)이 있으면 그것,
 *   없으면 경기 기록, 그것도 없으면 다음 칸 출전으로 추론. 결정과 경기 기록이 다르면 결정을 쓰되 문제로 알린다
 *   (실격·몰수·재경기는 경기 승자와 진출자가 다를 수 있다).
 * ★ 부전승·기권·취소는 결정으로만 생긴다. 출전자가 한 명뿐이라고 자동 승리시키지 않는다 — 상대를 아직 모르는 것일 수 있다.
 * ★ 확실성은 끝까지 따라간다. 추론한 결과를 거쳐 얻은 순위는 '추론'이다.
 * ★ 이 파일은 순수 함수다. DB 는 db/event-bracket.ts 가 읽어 이 입력 모양으로 넘긴다.
 */

export type EntrantId = string;
export type Side = "a" | "b";

export interface BracketSlot {
  id: string;
  stageNo: number;
  /** 주최측 경기 번호. 정렬·표시용 */
  no: number;
  label: string | null;
  /** 그림의 줄(「승자조」「패자조」「결정전」). null 이면 한 줄 */
  lane: string | null;
  kind: "match" | "selection";
  bestOf: number | null;
  /** selection 전용: 몇 명을 고르나 */
  picks: number | null;
  /** match 전용: 처음부터 정해진 출전자(시드·추첨) */
  seedA: EntrantId | null;
  seedB: EntrantId | null;
}

export type RouteTarget =
  | { kind: "slot"; slot: string; side: Side | null } // selection 칸으로 갈 때만 side 가 null
  | { kind: "placement"; min: number; max: number }
  | { kind: "eliminated" };

export interface BracketRoute {
  fromSlot: string;
  outcome: "winner" | "loser";
  to: RouteTarget;
}

/** 칸에 이어진 실제 경기 한 판. 참가자는 이미 참가 단위로 바뀌어 있다(진영이 세트마다 바뀌어도 같은 id). */
export interface SlotGame {
  slotId: string;
  matchId: string;
  playedAt: string;
  entrants: {
    entrant: EntrantId | null; outcome: "win" | "draw" | "loss" | "unknown"; score: number | null;
    /** 승부차기 점수(FC 의 shootOutScore). 승부차기가 없었거나 모르면 null */
    shootout?: number | null;
  }[];
}

export type DecisionStatus = "auto" | "result" | "walkover" | "forfeit" | "cancelled";
export type DecisionBasis = "official" | "observed" | "organizer" | "inferred";

/** 사람이 내린 칸 결정. 칸마다 최신 하나만 넘긴다. status 'auto' 는 "결정 철회 — 경기 기록대로". */
export interface SlotDecision {
  slotId: string;
  status: DecisionStatus;
  /** match 는 승자 1명, selection 은 고른 사람들. cancelled·auto 는 비어 있다 */
  winners: EntrantId[];
  scoreA: number | null;
  scoreB: number | null;
  basis: DecisionBasis;
  evidence: string;
}

/** 공식(또는 출처에서 사람이 유도한) 최종 순위. 범위로 공동 순위를 표현한다. */
export interface FinalRank {
  entrant: EntrantId;
  min: number;
  max: number;
  basis: "official" | "source_inferred";
}

export interface BracketInput {
  slots: BracketSlot[];
  routes: BracketRoute[];
  games: SlotGame[];
  decisions: SlotDecision[];
  finalRanks: FinalRank[];
}

/** 확실성. confirmed = 경기 기록·공식 발표·방송 확인, organizer = 주최측 재량(투표 등), inferred = 추론 */
export type Certainty = "confirmed" | "organizer" | "inferred";
const WEAKNESS: Record<Certainty, number> = { confirmed: 0, organizer: 1, inferred: 2 };
const weakest = (...xs: Certainty[]): Certainty => xs.reduce((a, b) => (WEAKNESS[b] > WEAKNESS[a] ? b : a), "confirmed");

export type SlotState =
  | "pending"     // 출전자가 다 안 정해졌다(앞 칸 미정)
  | "unrecorded"  // 출전자는 정해졌는데 결과를 모른다(기록 없음)
  | "decided"     // 경기 또는 결정으로 승자가 정해졌다
  | "walkover" | "forfeit" | "cancelled";

export interface ResolvedSlot {
  slot: BracketSlot;
  /** match 는 [a, b], selection 은 들어온 순서 */
  occupants: (EntrantId | null)[];
  state: SlotState;
  winners: EntrantId[];
  losers: EntrantId[];
  /** 승패를 어디서 정했나 */
  source: "match" | "decision" | "inferred" | null;
  basis: DecisionBasis | "match" | null;
  /** 채택 결과의 점수(세트 수 또는 단판 점수). 모르면 null */
  score: [number | null, number | null];
  /** 이 칸의 결과 + 출전자 결정까지 포함한 확실성 */
  certainty: Certainty;
  games: SlotGame[];
}

export interface ResolvedPlacement {
  entrant: EntrantId;
  /** 계산한 순위 범위. 탈락(순위 모름)이면 null */
  computed: { min: number; max: number } | null;
  eliminated: boolean;
  /** 순위를 확정한 칸의 확실성(그 칸의 결과 + 출전 확인) */
  certainty: Certainty;
  official: FinalRank | null;
}

export type IssueCode =
  | "unknown_slot" | "side_unfilled" | "side_double_filled" | "missing_route" | "duplicate_route"
  | "cycle" | "seed_twice" | "placement_overlap" | "placement_count" | "selection_picks"
  | "game_outsider" | "decision_outsider" | "decision_conflicts_match" | "decision_pick_count"
  | "official_mismatch" | "unreached_slot";

export interface BracketIssue {
  code: IssueCode;
  /** 구조 오류(error)는 계산을 믿을 수 없다. 경고(warning)는 검수할 것 */
  level: "error" | "warning";
  slotId?: string;
  entrant?: EntrantId;
  message: string;
}

export interface BracketResult {
  slots: ResolvedSlot[];
  placements: ResolvedPlacement[];
  issues: BracketIssue[];
}

/* ── 구조 검사 ────────────────────────────────────────────────────── */

/** 결과와 무관한 구조 오류. 저장 전에 이것이 비어 있어야 한다(저장 경로와 검증 스크립트가 같이 쓴다). */
export function validateStructure(slots: BracketSlot[], routes: BracketRoute[]): BracketIssue[] {
  const issues: BracketIssue[] = [];
  const byId = new Map(slots.map((s) => [s.id, s]));
  const err = (code: IssueCode, message: string, slotId?: string) => issues.push({ code, level: "error", message, slotId });

  for (const r of routes) {
    if (!byId.has(r.fromSlot)) err("unknown_slot", `화살표 출발 칸이 없다: ${r.fromSlot}`);
    if (r.to.kind === "slot" && !byId.has(r.to.slot)) err("unknown_slot", `화살표 도착 칸이 없다: ${r.to.slot}`, r.fromSlot);
  }
  // 칸마다 승자·패자 화살표가 하나씩
  for (const s of slots) {
    for (const outcome of ["winner", "loser"] as const) {
      const n = routes.filter((r) => r.fromSlot === s.id && r.outcome === outcome).length;
      if (n === 0) err("missing_route", `${label(s)}: ${outcome === "winner" ? "승자" : "패자"}가 갈 곳이 없다`, s.id);
      if (n > 1) err("duplicate_route", `${label(s)}: ${outcome === "winner" ? "승자" : "패자"} 화살표가 ${n}개다`, s.id);
    }
  }
  // match 칸의 두 자리는 시드 또는 화살표 하나로만 채워진다
  for (const s of slots.filter((x) => x.kind === "match")) {
    for (const side of ["a", "b"] as const) {
      const seeded = (side === "a" ? s.seedA : s.seedB) != null;
      const incoming = routes.filter((r) => r.to.kind === "slot" && r.to.slot === s.id && r.to.side === side).length;
      const fills = Number(seeded) + incoming;
      if (fills === 0) err("side_unfilled", `${label(s)} ${side} 자리를 채울 시드도 화살표도 없다`, s.id);
      if (fills > 1) err("side_double_filled", `${label(s)} ${side} 자리를 ${fills}곳이 채운다`, s.id);
    }
    if (routes.some((r) => r.to.kind === "slot" && r.to.slot === s.id && r.to.side == null))
      err("side_unfilled", `${label(s)}: match 칸으로 오는 화살표는 a/b 자리를 정해야 한다`, s.id);
  }
  for (const s of slots.filter((x) => x.kind === "selection")) {
    const incoming = routes.filter((r) => r.to.kind === "slot" && r.to.slot === s.id).length;
    if (!s.picks || s.picks < 1 || s.picks >= incoming)
      err("selection_picks", `${label(s)}: ${incoming}명 중 ${s.picks ?? "?"}명을 고른다 — 1명 이상, 전원 미만이어야 한다`, s.id);
  }
  // 같은 참가 단위를 두 번 시드
  const seeds = slots.flatMap((s) => [s.seedA, s.seedB]).filter((x): x is string => x != null);
  for (const e of new Set(seeds)) if (seeds.filter((x) => x === e).length > 1)
    issues.push({ code: "seed_twice", level: "error", entrant: e, message: `같은 참가 단위가 두 칸에 시드됐다: ${e}` });
  // 순환
  const next = new Map<string, string[]>();
  for (const r of routes) if (r.to.kind === "slot") next.set(r.fromSlot, [...(next.get(r.fromSlot) ?? []), r.to.slot]);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    const found = (next.get(id) ?? []).some(visit);
    state.set(id, 2);
    return found;
  };
  if (slots.some((s) => visit(s.id))) err("cycle", "화살표가 순환한다");
  // 순위 범위: 겹치지 않고, 범위 크기만큼 사람이 들어와야 한다(3–6위 4명과 3위 1명이 겹치면 안 된다)
  const ranges = new Map<string, { min: number; max: number; count: number }>();
  for (const r of routes) {
    if (r.to.kind !== "placement") continue;
    const key = `${r.to.min}-${r.to.max}`;
    const cur = ranges.get(key) ?? { min: r.to.min, max: r.to.max, count: 0 };
    cur.count += r.fromSlot && byId.get(r.fromSlot)?.kind === "selection"
      ? selectionCount(byId.get(r.fromSlot)!, r.outcome, routes) : 1;
    ranges.set(key, cur);
  }
  const list = [...ranges.values()].sort((a, b) => a.min - b.min);
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.max - r.min + 1 !== r.count)
      err("placement_count", `${rankText(r.min, r.max)}에 ${r.count}명이 들어온다 — ${r.max - r.min + 1}명이어야 한다`);
    if (i > 0 && list[i - 1].max >= r.min)
      err("placement_overlap", `${rankText(list[i - 1].min, list[i - 1].max)}와 ${rankText(r.min, r.max)}가 겹친다`);
  }
  return issues;
}

function selectionCount(s: BracketSlot, outcome: "winner" | "loser", routes: BracketRoute[]): number {
  const incoming = routes.filter((r) => r.to.kind === "slot" && r.to.slot === s.id).length;
  return outcome === "winner" ? s.picks ?? 0 : incoming - (s.picks ?? 0);
}

export const rankText = (min: number, max: number) => (min === max ? `${min}위` : `${min}–${max}위`);
const label = (s: BracketSlot) => `${s.no}경기${s.label ? ` · ${s.label}` : ""}`;

/* ── 결과 계산 ────────────────────────────────────────────────────── */

const BASIS_CERTAINTY: Record<DecisionBasis | "match", Certainty> = {
  match: "confirmed", official: "confirmed", observed: "confirmed", organizer: "organizer", inferred: "inferred",
};

/** 실제 경기들로 정한 match 칸의 승자. 세트는 참가 단위로 합산한다. 다 끝났다고 말할 수 없으면 null. */
export function matchWinner(games: SlotGame[], bestOf: number | null, occupants: (EntrantId | null)[]):
  { winner: EntrantId; loser: EntrantId | null; score: [number, number] } | null {
  if (!games.length) return null;
  const wins = new Map<EntrantId, number>();
  for (const g of games) for (const e of g.entrants) if (e.entrant && e.outcome === "win") wins.set(e.entrant, (wins.get(e.entrant) ?? 0) + 1);
  const known = occupants.filter((x): x is EntrantId => x != null);
  const people = known.length === 2 ? known : [...new Set(games.flatMap((g) => g.entrants.map((e) => e.entrant)).filter((x): x is string => x != null))];
  if (people.length !== 2) return null;
  const [a, b] = people;
  const wa = wins.get(a) ?? 0, wb = wins.get(b) ?? 0;
  // 단판(또는 형식 미상 한 판): 그 판의 승자. 여러 판인데 형식을 모르면 끝났는지 알 수 없다.
  const need = bestOf ? Math.floor(bestOf / 2) + 1 : games.length === 1 ? 1 : null;
  if (need == null) return null;
  const score: [number, number] = occupants[0] === b ? [wb, wa] : [wa, wb];
  if (wa >= need && wa > wb) return { winner: a, loser: b, score };
  if (wb >= need && wb > wa) return { winner: b, loser: a, score };
  return null;
}

export function resolveBracket(input: BracketInput): BracketResult {
  const issues = validateStructure(input.slots, input.routes);
  const slots = [...input.slots].sort((a, b) => a.stageNo - b.stageNo || a.no - b.no);
  const byId = new Map(slots.map((s) => [s.id, s]));
  const gamesBy = new Map<string, SlotGame[]>();
  for (const g of input.games) gamesBy.set(g.slotId, [...(gamesBy.get(g.slotId) ?? []), g]);
  const decisionBy = new Map(input.decisions.filter((d) => d.status !== "auto").map((d) => [d.slotId, d]));
  const into = (slotId: string) => input.routes.filter((r) => r.to.kind === "slot" && r.to.slot === slotId);
  const outOf = (slotId: string, outcome: "winner" | "loser") => input.routes.find((r) => r.fromSlot === slotId && r.outcome === outcome);

  // 추론한 승자(칸 → 승자). 추론이 다음 칸 출전자를 채우면 또 추론할 수 있어 고정점까지 처음부터 다시 푼다.
  const inferred = new Map<string, EntrantId>();
  let resolved = new Map<string, ResolvedSlot>();
  let runIssues: BracketIssue[] = [];
  const visiting = new Set<string>();
  // 칸의 출전자가 들어오는 앞 칸을 먼저 푼다(순환은 위에서 오류로 잡았다 — 그래도 무한 재귀는 막는다).
  const resolve = (id: string): ResolvedSlot => {
    const done = resolved.get(id);
    if (done) return done;
    const slot = byId.get(id)!;
    if (visiting.has(id)) return blank(slot);
    visiting.add(id);

    // 1. 출전자와 그 확실성. 앞 칸 결과로 들어온 사람은 앞 칸의 확실성을 물려받지만,
    //    이 칸의 경기 기록이나 확인된 결정에 이름이 나오면 출전 자체는 확인된 것이다.
    const occupants: (EntrantId | null)[] = [];
    const inherited: Certainty[] = [];
    const take = (route: BracketRoute | undefined, seed: EntrantId | null) => {
      if (seed) { occupants.push(seed); inherited.push("confirmed"); return; }
      if (!route) { occupants.push(null); inherited.push("confirmed"); return; }
      const src = resolve(route.fromSlot);
      const list = route.outcome === "winner" ? src.winners : src.losers;
      if (!list.length) { occupants.push(null); inherited.push("confirmed"); return; }
      for (const e of list) { occupants.push(e); inherited.push(src.certainty); }
    };
    if (slot.kind === "match") {
      const incoming = into(id);
      take(incoming.find((r) => r.to.kind === "slot" && r.to.side === "a"), slot.seedA);
      take(incoming.find((r) => r.to.kind === "slot" && r.to.side === "b"), slot.seedB);
    } else {
      for (const r of into(id)) take(r, null);
    }
    const games = (gamesBy.get(id) ?? []).sort((a, b) => a.playedAt.localeCompare(b.playedAt));
    // 앞 칸을 몰라 빈 자리가 하나인데, 이 칸의 실제 경기에 출전자 아닌 사람이 정확히 한 명 나왔으면 그가 그 자리다
    // (경기에 나온 것은 확인된 사실이다). 둘 이상이면 어느 자리인지 모르므로 채우지 않는다.
    if (slot.kind === "match" && occupants.filter((x) => x == null).length === 1) {
      const extra = [...new Set(games.flatMap((g) => g.entrants.map((e) => e.entrant)))]
        .filter((e): e is EntrantId => e != null && !occupants.includes(e));
      if (extra.length === 1) {
        const i = occupants.indexOf(null);
        occupants[i] = extra[0];
        inherited[i] = "confirmed";
      }
    }
    const ready = occupants.length > 0 && occupants.every((x) => x != null);

    // 경기에 출전자가 아닌 사람이 나오면 연결 오류다
    if (ready) for (const g of games) for (const e of g.entrants)
      if (e.entrant && !occupants.includes(e.entrant))
        runIssues.push({ code: "game_outsider", level: "warning", slotId: id, entrant: e.entrant, message: `${label(slot)}에 이어진 경기에 출전자가 아닌 참가 단위가 있다` });

    // 2. 채택 결과
    const decision = decisionBy.get(id);
    const actual = slot.kind === "match" ? matchWinner(games, slot.bestOf, occupants) : null;
    let out: Omit<ResolvedSlot, "slot" | "occupants" | "games">;
    if (decision) {
      if (decision.status === "cancelled") {
        out = { state: "cancelled", winners: [], losers: [], source: "decision", basis: decision.basis, score: [null, null], certainty: BASIS_CERTAINTY[decision.basis] };
      } else {
        const winners = decision.winners;
        const expected = slot.kind === "selection" ? slot.picks ?? 0 : 1;
        if (winners.length !== expected)
          runIssues.push({ code: "decision_pick_count", level: "error", slotId: id, message: `${label(slot)}: 결정의 승자가 ${winners.length}명이다 — ${expected}명이어야 한다` });
        if (ready && winners.some((w) => !occupants.includes(w)))
          runIssues.push({ code: "decision_outsider", level: "error", slotId: id, message: `${label(slot)}: 결정한 승자가 출전자가 아니다` });
        if (actual && slot.kind === "match" && winners[0] !== actual.winner)
          runIssues.push({ code: "decision_conflicts_match", level: "warning", slotId: id, message: `${label(slot)}: 채택한 결과가 경기 기록과 다르다(실격·몰수·재경기라면 근거를 확인)` });
        const losers = ready ? occupants.filter((x): x is string => x != null && !winners.includes(x)) : [];
        out = {
          state: decision.status === "walkover" ? "walkover" : decision.status === "forfeit" ? "forfeit" : "decided",
          winners, losers, source: "decision", basis: decision.basis,
          score: [decision.scoreA, decision.scoreB], certainty: BASIS_CERTAINTY[decision.basis],
        };
      }
    } else if (actual) {
      out = { state: "decided", winners: [actual.winner], losers: actual.loser ? [actual.loser] : [], source: "match", basis: "match", score: actual.score, certainty: "confirmed" };
    } else if (inferred.has(id) && occupants.includes(inferred.get(id)!)) {
      // 상대를 몰라도(앞 칸 미정) 이긴 사람은 안다 — 패자는 모름으로 남긴다
      const w = inferred.get(id)!;
      out = { state: "decided", winners: [w], losers: occupants.filter((x): x is string => x != null && x !== w), source: "inferred", basis: "inferred", score: [null, null], certainty: "inferred" };
    } else {
      out = { state: ready ? "unrecorded" : "pending", winners: [], losers: [], source: null, basis: null, score: [null, null], certainty: "confirmed" };
    }
    const present = new Set<EntrantId | null>(games.flatMap((g) => g.entrants.map((e) => e.entrant)));
    if (decision && BASIS_CERTAINTY[decision.basis] === "confirmed") for (const w of decision.winners) present.add(w);
    const occupantCertainty = weakest(...occupants.map((e, i) => (e && present.has(e) ? "confirmed" : inherited[i])));
    out.certainty = weakest(out.certainty, occupantCertainty);
    const result: ResolvedSlot = { slot, occupants, games, ...out };
    resolved.set(id, result);
    visiting.delete(id);
    return result;
  };
  const run = () => {
    resolved = new Map();
    runIssues = [];
    for (const s of slots) resolve(s.id);
  };
  run();

  // 3. 추론: 결과를 모르는 match 칸에서, 승자(또는 패자) 화살표가 가는 칸의 실제 경기에 두 출전자 중 정확히
  //    한 명만 나왔으면 그쪽으로 갔다고 본다. 양쪽 칸 모두 기록이 있는데 서로 어긋나면 추론하지 않는다.
  const entrantsIn = (slotId: string) => new Set((gamesBy.get(slotId) ?? []).flatMap((g) => g.entrants.map((e) => e.entrant)));
  const onlyOne = (seen: Set<EntrantId | null> | null, a: EntrantId, b: EntrantId) =>
    !seen || !seen.size ? null : seen.has(a) && !seen.has(b) ? a : seen.has(b) && !seen.has(a) ? b : undefined;
  for (let changed = true; changed;) {
    changed = false;
    for (const s of slots) {
      const r = resolved.get(s.id)!;
      if (s.kind !== "match" || r.winners.length || r.state === "cancelled" || inferred.has(s.id)) continue;
      const [a, b] = r.occupants;
      const win = outOf(s.id, "winner"), lose = outOf(s.id, "loser");
      if (a == null || b == null) {
        // 출전자 한 명만 안다: 그 사람이 승자 칸 경기에 나왔으면 이겼다(상대는 모름)
        const known = a ?? b;
        if (known && win?.to.kind === "slot" && entrantsIn(win.to.slot).has(known)) { inferred.set(s.id, known); changed = true; }
        continue;
      }
      // null = 그 칸에 기록이 없다, undefined = 기록은 있는데 한 명으로 좁혀지지 않는다
      const byWin = onlyOne(win?.to.kind === "slot" ? entrantsIn(win.to.slot) : null, a, b);
      const byLose = onlyOne(lose?.to.kind === "slot" ? entrantsIn(lose.to.slot) : null, a, b);
      if (byWin === undefined || byLose === undefined) continue;
      const fromLose = byLose ? (byLose === a ? b : a) : null;
      const pick = byWin ?? fromLose;
      if (!pick || (byWin && fromLose && byWin !== fromLose)) continue;
      inferred.set(s.id, pick);
      changed = true;
    }
    if (changed) run();
  }
  issues.push(...runIssues);

  const all = slots.map((s) => resolved.get(s.id)!);

  // 4. 순위
  // 순위의 확실성 = 순위를 확정한 칸의 확실성(그 칸의 결과 + 그 칸 출전자 확인).
  const placements = new Map<EntrantId, ResolvedPlacement>();
  for (const r of all) {
    for (const outcome of ["winner", "loser"] as const) {
      const route = outOf(r.slot.id, outcome);
      if (!route || route.to.kind === "slot") continue;
      for (const e of outcome === "winner" ? r.winners : r.losers) {
        placements.set(e, {
          entrant: e,
          computed: route.to.kind === "placement" ? { min: route.to.min, max: route.to.max } : null,
          eliminated: route.to.kind === "eliminated",
          certainty: r.certainty,
          official: null,
        });
      }
    }
  }
  for (const f of input.finalRanks) {
    const p = placements.get(f.entrant) ?? { entrant: f.entrant, computed: null, eliminated: false, certainty: "confirmed" as Certainty, official: null };
    p.official = f;
    placements.set(f.entrant, p);
    if (f.basis === "official" && p.computed && (p.computed.min !== f.min || p.computed.max !== f.max))
      issues.push({ code: "official_mismatch", level: "warning", entrant: f.entrant, message: `계산 순위 ${rankText(p.computed.min, p.computed.max)}가 공식 ${rankText(f.min, f.max)}와 다르다 — 화살표나 결과를 확인` });
  }

  // 시드·화살표 어디서도 닿지 않는 칸
  for (const s of slots) if (s.kind === "match" && !s.seedA && !s.seedB && into(s.id).length === 0)
    issues.push({ code: "unreached_slot", level: "error", slotId: s.id, message: `${label(s)}: 아무도 들어오지 않는다` });

  return {
    slots: all,
    placements: [...placements.values()].sort((a, b) => rankOf(a) - rankOf(b)),
    issues,
  };
}

/** 화면이 보일 순위. 공식이 있으면 공식, 없으면 계산. */
export function displayRank(p: ResolvedPlacement): { min: number; max: number; from: "official" | "source_inferred" | "computed" } | null {
  if (p.official) return { min: p.official.min, max: p.official.max, from: p.official.basis };
  return p.computed ? { ...p.computed, from: "computed" } : null;
}
const rankOf = (p: ResolvedPlacement) => displayRank(p)?.min ?? 999;

function blank(slot: BracketSlot): ResolvedSlot {
  return { slot, occupants: [], state: "pending", winners: [], losers: [], source: null, basis: null, score: [null, null], certainty: "confirmed", games: [] };
}

/* ── 그림 배치 ────────────────────────────────────────────────────── */

/** 칸의 가로 위치 = 시작 칸(들어오는 칸 화살표가 없는 칸)에서의 최장 화살표 깊이. 줄(lane)은 칸이 정한다. */
export function slotDepths(slots: BracketSlot[], routes: BracketRoute[]): Map<string, number> {
  const prev = new Map<string, string[]>();
  for (const r of routes) if (r.to.kind === "slot") prev.set(r.to.slot, [...(prev.get(r.to.slot) ?? []), r.fromSlot]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const of = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...(prev.get(id) ?? []).map(of)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const s of slots) of(s.id);
  return depth;
}
