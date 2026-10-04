import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  displayRank, rankText, resolveBracket, validateStructure,
  type BracketInput, type BracketSlot, type SlotGame,
} from "./bracket.ts";
import { doubleElimination, singleElimination } from "./templates.ts";
import { parseBracketSpec, type BracketSpec } from "./spec.ts";

const ROOT = join(import.meta.dirname, "../../../..");

/** [승자, 패자, 승자 점수, 패자 점수] 단판 경기 */
function game(slotId: string, matchId: string, w: string, l: string, ws: number | null = null, ls: number | null = null): SlotGame {
  return { slotId, matchId, playedAt: matchId, entrants: [
    { entrant: w, outcome: "win", score: ws }, { entrant: l, outcome: "loss", score: ls },
  ] };
}
const ranks = (input: BracketInput) => Object.fromEntries(resolveBracket(input).placements.map((p) => {
  const r = displayRank(p);
  return [p.entrant, r ? rankText(r.min, r.max) : "—"];
}));
const errors = (input: BracketInput) => resolveBracket(input).issues.filter((i) => i.level === "error");

/* ── 실제 대회 1: 2026 LoL 멸망전 — 도우미(더블 엘리미네이션 8)가 그대로 맞는가 ─────────────── */

// DB 의 세트 기록 그대로: [시리즈, 청, 적, 이긴 진영]. 진영이 세트마다 바뀐다 — 참가 단위로 합산해야 한다.
const MELJANG_SETS: [string, string, string, 100 | 200][] = [
  ["g01", "명 수", "노종뀨뀨낭", 200], ["g01", "명 수", "노종뀨뀨낭", 100], ["g01", "명 수", "노종뀨뀨낭", 200],
  ["g02", "막차타요", "저로듀스lol", 100], ["g02", "저로듀스lol", "막차타요", 100], ["g02", "막차타요", "저로듀스lol", 100],
  ["g03", "임부장", "교권보호국", 200], ["g03", "임부장", "교권보호국", 100], ["g03", "교권보호국", "임부장", 100],
  ["g04", "딕닦꺼 브라더즈", "고점폭발", 200], ["g04", "고점폭발", "딕닦꺼 브라더즈", 100],
  ["g05", "노종뀨뀨낭", "막차타요", 100], ["g05", "노종뀨뀨낭", "막차타요", 200], ["g05", "노종뀨뀨낭", "막차타요", 200],
  ["g06", "저로듀스lol", "명 수", 100], ["g06", "저로듀스lol", "명 수", 200], ["g06", "명 수", "저로듀스lol", 200],
  ["g07", "고점폭발", "교권보호국", 100], ["g07", "교권보호국", "고점폭발", 100], ["g07", "고점폭발", "교권보호국", 100],
  ["g08", "임부장", "딕닦꺼 브라더즈", 200], ["g08", "딕닦꺼 브라더즈", "임부장", 100],
  ["g09", "저로듀스lol", "노종뀨뀨낭", 200], ["g09", "노종뀨뀨낭", "저로듀스lol", 100],
  ["g10", "교권보호국", "딕닦꺼 브라더즈", 200], ["g10", "교권보호국", "딕닦꺼 브라더즈", 100], ["g10", "딕닦꺼 브라더즈", "교권보호국", 200],
  ["g11", "고점폭발", "막차타요", 100], ["g11", "막차타요", "고점폭발", 200],
  ["g12", "교권보호국", "노종뀨뀨낭", 100], ["g12", "노종뀨뀨낭", "교권보호국", 200],
  ["g13", "교권보호국", "막차타요", 100], ["g13", "교권보호국", "막차타요", 100],
  ["g14", "고점폭발", "교권보호국", 200], ["g14", "고점폭발", "교권보호국", 100], ["g14", "고점폭발", "교권보호국", 200],
];
const MELJANG_RANKS = {
  "교권보호국": "1위", "고점폭발": "2위", "막차타요": "3위", "노종뀨뀨낭": "4위",
  "딕닦꺼 브라더즈": "5–6위", "저로듀스lol": "5–6위", "명 수": "7–8위", "임부장": "7–8위",
};
const meljangGames = (slotOf: (series: string) => string, matchId: (series: string, n: number) => string): SlotGame[] => {
  const seen = new Map<string, number>();
  return MELJANG_SETS.map(([series, blue, red, won], i) => {
    const n = (seen.get(series) ?? 0) + 1;
    seen.set(series, n);
    return {
      slotId: slotOf(series), matchId: matchId(series, n), playedAt: String(i).padStart(3, "0"),
      entrants: [
        { entrant: blue, outcome: won === 100 ? "win" : "loss", score: null },
        { entrant: red, outcome: won === 200 ? "win" : "loss", score: null },
      ],
    };
  });
};

test("롤 2026 멸망전 시드 파일(seed/brackets): 파일의 칸·경기 연결로 공식 순위가 나온다", () => {
  const spec = JSON.parse(readFileSync(join(ROOT, "seed/brackets/meljang-2026-geng.json"), "utf8")) as BracketSpec;
  const parsed = parseBracketSpec(spec);
  // 파일이 잇는 경기 id 가 DB 의 세트 id 와 같은 규칙인지 — 칸 n 은 g0n 시리즈의 세트들
  const games = meljangGames((series) => `1:${Number(series.slice(1))}`, (series, n) => `meljang-2026-geng:${series}s${n}`);
  for (const g of games) assert.ok(parsed.links.get(g.slotId)?.includes(g.matchId), `${g.matchId} 가 ${g.slotId} 에 이어져 있다`);
  const input: BracketInput = { slots: parsed.slots, routes: parsed.routes, games, decisions: parsed.decisions, finalRanks: parsed.finalRanks };
  assert.deepEqual(resolveBracket(input).issues, []);
  assert.deepEqual(ranks(input), MELJANG_RANKS);
});

test("롤 2026 멸망전: 더블 엘리미네이션 도우미 + 실제 세트 기록만으로 공식 순위가 그대로 나온다", () => {
  const t = doubleElimination(8, { bestOf: 3 });
  // 도우미는 진행 순서로 번호를 매긴다. 주최측 번호(g01…)와의 대응:
  const organizer: Record<string, string> = {
    g01: "s1", g02: "s2", g03: "s3", g04: "s4", g06: "s5", g08: "s6", g05: "s7", g07: "s8",
    g09: "s9", g10: "s10", g12: "s11", g11: "s12", g13: "s13", g14: "s14",
  };
  const seeds: [string, string, string][] = [["s1", "명 수", "노종뀨뀨낭"], ["s2", "막차타요", "저로듀스lol"], ["s3", "임부장", "교권보호국"], ["s4", "딕닦꺼 브라더즈", "고점폭발"]];
  const slots = t.slots.map((s): BracketSlot => {
    const seed = seeds.find(([id]) => id === s.id);
    return seed ? { ...s, seedA: seed[1], seedB: seed[2] } : s;
  });
  const games = meljangGames((series) => organizer[series], (series, n) => `${series}s${n}`);
  const input: BracketInput = { slots, routes: t.routes, games, decisions: [], finalRanks: [] };
  assert.deepEqual(errors(input), []);
  assert.deepEqual(ranks(input), MELJANG_RANKS);
  const result = resolveBracket(input);
  assert.ok(result.placements.every((p) => p.certainty === "confirmed"));
  // 결승 세트 점수는 참가 단위 기준(진영 무관)
  const final = result.slots.find((s) => s.slot.id === "s14")!;
  assert.equal(final.winners[0], "교권보호국");
  assert.deepEqual([...final.score].sort(), [1, 2]);
});

/* ── 실제 대회 2: 뿌챔스 — 커스텀(순위 결정전 계단) + 기록 없는 칸 4개 ─────────────────────── */

const PPUCHAMPS = JSON.parse(readFileSync(join(ROOT, "seed/brackets/2026-mini-ppuchamps.json"), "utf8")) as BracketSpec;
/** 넥슨 API 기록(DB 그대로): match_id → [승자, 패자, 승자 점수, 패자 점수] */
const PPUCHAMPS_GAMES: Record<string, [string, string, number, number]> = {
  "fco:6a8d4fe066b9776fe4e71070": ["imyujin", "doochiwa-ppukku", 3, 2],
  "fco:6a8d53c28c7e4462645fc1c2": ["smebim", "clid1", 2, 1],
  "fco:6a8d574d17f5a560e6a5a6f5": ["kimmingyo", "seodoil", 2, 2],
  "fco:6a8d5cd2e3c14f0cfe6d936a": ["dohyun", "leesangho", 4, 2],
  "fco:6a8d60a20e63f4b38dacb741": ["smebim", "imyujin", 2, 1],
  "fco:6a8d63d377042869cc5c6b56": ["dohyun", "kimmingyo", 2, 1],
  "fco:6a8d675f14c88e1864cd70bf": ["doochiwa-ppukku", "clid1", 2, 1],
  "fco:6a8d6ae0cd571e3d4ac70490": ["leesangho", "seodoil", 2, 1],
  "fco:6a8d6e6b65a9205e405ea643": ["smebim", "dohyun", 2, 0],
  "fco:6a8d75607caf4e2b24437b13": ["imyujin", "kimmingyo", 3, 1],
  "fco:6a8d78b6f9eabe4e7810c8d9": ["doochiwa-ppukku", "leesangho", 2, 1],
  "fco:6a8d7c04e379e7e63b5a5697": ["leesangho", "clid1", 5, 3],
  "fco:6a8d83497095898040774f83": ["kimmingyo", "doochiwa-ppukku", 3, 1],
  "fco:6a8d8680a8db38b21d96e4af": ["leesangho", "doochiwa-ppukku", 4, 1],
  "fco:6a8d8a0676472064f023136a": ["imyujin", "smebim", 4, 1],
  "fco:6a8d8d2a3127b1bfcb7d9751": ["dohyun", "kimmingyo", 3, 2],
  "fco:6a8d91a8c7f13dff46e7c00d": ["leesangho", "kimmingyo", 1, 0],
  "fco:6a8d9596cf80344b0ed41458": ["dohyun", "smebim", 3, 3],
  "fco:6a8d9a0b73e031dce3609ee8": ["smebim", "leesangho", 1, 0],
  "fco:6a8da1b6b50f4b19579a2d5a": ["dohyun", "smebim", 3, 2],
};
function ppuchampsInput(): BracketInput {
  const parsed = parseBracketSpec(PPUCHAMPS);
  const games = [...parsed.links].flatMap(([slotId, ids]) => ids.map((id) => {
    const [w, l, ws, ls] = PPUCHAMPS_GAMES[id];
    return game(slotId, id, w, l, ws, ls);
  }));
  return { slots: parsed.slots, routes: parsed.routes, games, decisions: parsed.decisions, finalRanks: parsed.finalRanks };
}

test("뿌챔스: 구조 오류가 없고, 기록 없는 칸이 있어도 공식 1~4위와 맞는 순위가 나온다", () => {
  const input = ppuchampsInput();
  const result = resolveBracket(input);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(ranks(input), {
    imyujin: "1위", dohyun: "2위", smebim: "3위", leesangho: "4위",
    kimmingyo: "5위", "doochiwa-ppukku": "6위", clid1: "7위", seodoil: "8위",
  });
  // 공식 발표가 없는 5~8위는 계산값이다
  const by = new Map(result.placements.map((p) => [p.entrant, p]));
  assert.equal(displayRank(by.get("kimmingyo")!)?.from, "computed");
  assert.equal(displayRank(by.get("imyujin")!)?.from, "official");
});

test("뿌챔스: 기록 없는 10·14·22경기는 다음 칸 출전으로 추론하고, 그 추론은 순위의 확실성까지 따라간다", () => {
  const result = resolveBracket(ppuchampsInput());
  const slot = (no: number) => result.slots.find((s) => s.slot.no === no)!;
  assert.deepEqual([slot(10).winners, slot(10).source], [["clid1"], "inferred"]);
  assert.deepEqual([slot(14).winners, slot(14).source], [["imyujin"], "inferred"]);
  assert.deepEqual([slot(22).winners, slot(22).source], [["imyujin"], "inferred"]); // 패자 도현이 23경기에 나왔다
  assert.deepEqual([slot(24).winners, slot(24).source, slot(24).basis], [["imyujin"], "decision", "official"]);
  const by = new Map(result.placements.map((p) => [p.entrant, p.certainty]));
  assert.equal(by.get("seodoil"), "inferred");   // 8위는 추론한 10경기에서 정해졌다
  assert.equal(by.get("clid1"), "confirmed");    // 13경기에 실제로 나와 졌다 — 앞 칸 추론과 무관
  assert.equal(by.get("leesangho"), "confirmed");
  // 20경기는 3:3 이지만 승패 기록이 있어 승자가 정해진다
  assert.deepEqual(slot(20).winners, ["dohyun"]);
});

test("뿌챔스: 화살표 하나를 잘못 그리면 공식 순위와 어긋나 경고가 뜬다", () => {
  const input = ppuchampsInput();
  // 21경기(4위 결정전) 패자를 3위로 잘못 보낸다 → 범위 검사(3위 2명)와 공식 불일치가 같이 잡힌다
  const routes = input.routes.map((r) => r.fromSlot === "1:21" && r.outcome === "loser" ? { ...r, to: { kind: "placement" as const, min: 3, max: 3 } } : r);
  const codes = resolveBracket({ ...input, routes }).issues.map((i) => i.code);
  assert.ok(codes.includes("placement_count"));
  assert.ok(codes.includes("official_mismatch"));
});

/* ── 예외 규칙 ───────────────────────────────────────────────────────────────── */

const four = () => {
  const t = singleElimination(4, { bestOf: 1 });
  t.slots[0] = { ...t.slots[0], seedA: "A", seedB: "B" };
  t.slots[1] = { ...t.slots[1], seedA: "C", seedB: "D" };
  return t;
};

test("상대가 아직 미정이면 한 명뿐이어도 부전승이 아니다 — 부전승은 결정으로만 생긴다", () => {
  const t = four();
  const base: BracketInput = { ...t, games: [game("s1", "m1", "A", "B")], decisions: [], finalRanks: [] };
  const final = resolveBracket(base).slots.find((s) => s.slot.id === "s3")!;
  assert.equal(final.state, "pending");
  assert.deepEqual(final.winners, []);
  // C 의 상대 D 가 기권했다고 주최측이 선언 → 그때 C 가 올라간다
  const withWalkover = resolveBracket({ ...base, decisions: [{ slotId: "s2", status: "walkover", winners: ["C"], scoreA: null, scoreB: null, basis: "official", evidence: "공지" }] });
  assert.equal(withWalkover.slots.find((s) => s.slot.id === "s2")!.state, "walkover");
  assert.deepEqual(withWalkover.slots.find((s) => s.slot.id === "s3")!.occupants, ["A", "C"]);
});

test("실격·몰수: 채택 결정이 경기 기록과 다르면 결정을 쓰고 경고를 낸다. 결정을 철회(auto)하면 경기 기록으로 돌아간다", () => {
  const t = four();
  const games = [game("s1", "m1", "A", "B"), game("s2", "m2", "C", "D"), game("s3", "m3", "A", "C")];
  const forfeit = { slotId: "s1", status: "forfeit" as const, winners: ["B"], scoreA: null, scoreB: null, basis: "official" as const, evidence: "A 실격 공지" };
  const r1 = resolveBracket({ ...t, games, decisions: [forfeit], finalRanks: [] });
  assert.deepEqual(r1.slots.find((s) => s.slot.id === "s1")!.winners, ["B"]);
  assert.ok(r1.issues.some((i) => i.code === "decision_conflicts_match"));
  // 결승 경기 기록에는 A 가 나온다 — B 가 올라갔으니 연결 오류로 알린다
  assert.ok(r1.issues.some((i) => i.code === "game_outsider"));
  const r2 = resolveBracket({ ...t, games, decisions: [{ ...forfeit, status: "auto", winners: [] }], finalRanks: [] });
  assert.deepEqual(r2.slots.find((s) => s.slot.id === "s1")!.winners, ["A"]);
  assert.equal(r2.issues.length, 0);
});

test("취소된 칸은 승자도 패자도 없고, 뒤 칸은 미정으로 남는다", () => {
  const t = four();
  const r = resolveBracket({ ...t, games: [], decisions: [{ slotId: "s1", status: "cancelled", winners: [], scoreA: null, scoreB: null, basis: "official", evidence: "취소 공지" }], finalRanks: [] });
  assert.equal(r.slots.find((s) => s.slot.id === "s1")!.state, "cancelled");
  assert.equal(r.slots.find((s) => s.slot.id === "s3")!.state, "pending");
});

test("BO3 인데 1:1 이면 끝나지 않았다 — 승자를 정하지 않는다. 형식 미상 여러 판도 마찬가지", () => {
  const t = four();
  const slots = t.slots.map((s) => ({ ...s, bestOf: s.id === "s1" ? 3 : null }));
  const games = [game("s1", "a", "A", "B"), game("s1", "b", "B", "A"), game("s2", "c", "C", "D"), game("s2", "d", "D", "C")];
  const r = resolveBracket({ slots, routes: t.routes, games, decisions: [], finalRanks: [] });
  assert.equal(r.slots.find((s) => s.slot.id === "s1")!.state, "unrecorded");
  assert.equal(r.slots.find((s) => s.slot.id === "s2")!.state, "unrecorded");
});

test("주최측 선택(투표 부활)은 selection 칸으로 — 고른 사람만 올라가고 확실성은 「주최측 결정」으로 따라간다", () => {
  // 6명: 1라운드 3판 → 승자 3명은 4강, 패자 3명 중 투표로 1명 부활해 4강 남은 자리, 못 고른 2명은 공동 5–6위.
  // 4강 패자는 공동 3–4위(3위전 없음), 결승.
  const slot = (no: number, extra: Partial<BracketSlot> = {}): BracketSlot =>
    ({ id: `s${no}`, stageNo: 1, no, label: null, lane: null, kind: "match", bestOf: 1, picks: null, seedA: null, seedB: null, ...extra });
  const slots = [
    slot(1, { seedA: "A", seedB: "B" }), slot(2, { seedA: "C", seedB: "D" }), slot(3, { seedA: "E", seedB: "F" }),
    slot(4, { kind: "selection", picks: 1, label: "시청자 투표 부활", bestOf: null }),
    slot(5), slot(6), slot(7, { label: "결승" }),
  ];
  const to = (from: string, outcome: "winner" | "loser", target: BracketInput["routes"][number]["to"]) => ({ fromSlot: from, outcome, to: target });
  const routes = [
    to("s1", "winner", { kind: "slot", slot: "s5", side: "a" }), to("s1", "loser", { kind: "slot", slot: "s4", side: null }),
    to("s2", "winner", { kind: "slot", slot: "s5", side: "b" }), to("s2", "loser", { kind: "slot", slot: "s4", side: null }),
    to("s3", "winner", { kind: "slot", slot: "s6", side: "a" }), to("s3", "loser", { kind: "slot", slot: "s4", side: null }),
    to("s4", "winner", { kind: "slot", slot: "s6", side: "b" }), to("s4", "loser", { kind: "placement", min: 5, max: 6 }),
    to("s5", "winner", { kind: "slot", slot: "s7", side: "a" }), to("s5", "loser", { kind: "placement", min: 3, max: 4 }),
    to("s6", "winner", { kind: "slot", slot: "s7", side: "b" }), to("s6", "loser", { kind: "placement", min: 3, max: 4 }),
    to("s7", "winner", { kind: "placement", min: 1, max: 1 }), to("s7", "loser", { kind: "placement", min: 2, max: 2 }),
  ];
  assert.deepEqual(validateStructure(slots, routes), []);
  const games = [game("s1", "1", "A", "B"), game("s2", "2", "C", "D"), game("s3", "3", "E", "F"), game("s5", "5", "A", "C"), game("s6", "6", "D", "E"), game("s7", "7", "A", "D")];
  // 투표 결과를 아직 안 넣었다 → 6번 칸은 미정, 그 뒤 결승 b 자리도 미정이라 1·2위를 정하지 않는다
  const before = resolveBracket({ slots, routes, games: games.filter((g) => !["6", "7"].includes(g.matchId)), decisions: [], finalRanks: [] });
  assert.equal(before.slots.find((s) => s.slot.id === "s6")!.state, "pending");
  assert.equal(before.placements.find((p) => p.entrant === "A")?.computed?.min, undefined);
  const vote = { slotId: "s4", status: "result" as const, winners: ["D"], scoreA: null, scoreB: null, basis: "organizer" as const, evidence: "투표 결과 공지" };
  const r = resolveBracket({ slots, routes, games, decisions: [vote], finalRanks: [] });
  assert.deepEqual(r.issues, []);
  const by = new Map(r.placements.map((p) => [p.entrant, p]));
  assert.deepEqual(by.get("B")?.computed, { min: 5, max: 6 });
  assert.equal(by.get("B")?.certainty, "organizer");
  assert.deepEqual(by.get("A")?.computed, { min: 1, max: 1 });
  // 부활한 D 는 결승에 실제로 나왔다 — 결승 순위는 경기로 확인된다
  assert.equal(by.get("D")?.certainty, "confirmed");
});

test("구조 검사: 순위 범위 겹침, 빈 자리, 같은 자리를 두 곳이 채움, 승자가 갈 곳 없음", () => {
  const t = four();
  const bad = t.routes.map((r) => r.fromSlot === "s1" && r.outcome === "loser" ? { ...r, to: { kind: "placement" as const, min: 3, max: 6 } } : r);
  assert.ok(validateStructure(t.slots, bad).some((i) => i.code === "placement_overlap" || i.code === "placement_count"));
  const unfilled = t.slots.map((s) => s.id === "s1" ? { ...s, seedA: null } : s);
  assert.ok(validateStructure(unfilled, t.routes).some((i) => i.code === "side_unfilled"));
  const double = t.slots.map((s) => s.id === "s3" ? { ...s, seedA: "X" } : s);
  assert.ok(validateStructure(double, t.routes).some((i) => i.code === "side_double_filled"));
  const missing = t.routes.filter((r) => !(r.fromSlot === "s3" && r.outcome === "winner"));
  assert.ok(validateStructure(t.slots, missing).some((i) => i.code === "missing_route"));
});

test("도우미가 만드는 대표 형식은 구조 오류가 없다", () => {
  for (const n of [4, 8, 16, 32]) {
    const s = singleElimination(n);
    const seeded = s.slots.map((x, i) => i < n / 2 ? { ...x, seedA: `a${i}`, seedB: `b${i}` } : x);
    assert.deepEqual(validateStructure(seeded, s.routes), [], `single ${n}`);
    const third = singleElimination(n, { thirdPlace: true });
    const seeded3 = third.slots.map((x, i) => i < n / 2 ? { ...x, seedA: `a${i}`, seedB: `b${i}` } : x);
    assert.deepEqual(validateStructure(seeded3, third.routes), [], `single+3rd ${n}`);
    const d = doubleElimination(n);
    const wb1 = d.slots.filter((x) => x.label?.startsWith("승자조 1라운드") || (n === 4 && x.label?.startsWith("승자조 1")));
    const seededD = d.slots.map((x) => wb1.includes(x) ? { ...x, seedA: `a${x.no}`, seedB: `b${x.no}` } : x);
    assert.deepEqual(validateStructure(seededD, d.routes), [], `double ${n}`);
  }
});
