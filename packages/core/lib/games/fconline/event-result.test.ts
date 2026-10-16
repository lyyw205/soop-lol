import assert from "node:assert/strict";
import { test } from "node:test";
import { fcoEventResult } from "./event-result.ts";
import { singleElimination } from "../../tournament/templates.ts";
import type { BracketInput, SlotGame } from "../../tournament/bracket.ts";

const game = (id: string, winner: string, loser: string): SlotGame => ({
  slotId: "final", matchId: id, playedAt: id,
  entrants: [{ entrant: winner, outcome: "win", score: 4 }, { entrant: loser, outcome: "loss", score: 1 }],
});
function bracket() {
  const input: BracketInput = {
    slots: [{ id: "final", stageNo: 1, no: 1, label: "CK", lane: null, kind: "match", bestOf: 3, picks: null, seedA: "a", seedB: "b" }],
    routes: [
      { fromSlot: "final", outcome: "winner", to: { kind: "placement", min: 1, max: 1 } },
      { fromSlot: "final", outcome: "loser", to: { kind: "placement", min: 2, max: 2 } },
    ],
    games: [game("1", "a", "b"), game("2", "b", "a"), game("3", "a", "b")],
    decisions: [], finalRanks: [],
  };
  return { input, entrants: [{ id: "a", name: "A팀", members: [] }, { id: "b", name: "B팀", members: [] }] };
}

test("CK는 마지막 골 점수 대신 진영과 무관한 팀별 종합 세트 스코어를 표시한다", () => {
  const source = bracket();
  source.input.games.splice(1, 0, { slotId: "final", matchId: "draw", playedAt: "1.5", entrants: [
    { entrant: "a", outcome: "draw", score: 2 }, { entrant: "b", outcome: "draw", score: 2 },
  ] });
  const result = fcoEventResult(source)!;
  assert.equal(result.label, "종합 스코어");
  assert.deepEqual(result.sides.map((side) => [side.name, side.score, side.won]), [["A팀", 2, true], ["B팀", 1, false]]);
});

test("부분 수집·형식 미확인·대진 없음은 최종 결과로 둔갑하지 않는다", () => {
  assert.equal(fcoEventResult(null), null);
  const partial = bracket();
  partial.input.games = partial.input.games.slice(0, 1);
  assert.equal(fcoEventResult(partial), null);
  partial.input.slots[0].bestOf = null;
  assert.equal(fcoEventResult(partial), null);
});

test("기록이 일부여도 확인된 행사 결정의 스코어를 우선하며 추론한 값은 표시하지 않는다", () => {
  const source = bracket();
  source.input.games = source.input.games.slice(0, 1);
  source.input.decisions = [{ slotId: "final", status: "result", winners: ["b"], scoreA: 5, scoreB: 7, basis: "observed", evidence: "방송에서 확인한 종합 결과" }];
  assert.deepEqual(fcoEventResult(source)?.sides.map((s) => [s.score, s.won]), [[5, false], [7, true]]);
  source.input.decisions[0].basis = "inferred";
  assert.equal(fcoEventResult(source), null);
  source.input.decisions[0].basis = "official";
  source.input.decisions[0].scoreB = null;
  assert.equal(fcoEventResult(source), null);
});

test("여러 팀이 참여하는 대회는 결승 스코어를 명시하고 준결승 점수는 합산하지 않는다", () => {
  const template = singleElimination(4, { bestOf: 3 });
  const source = bracket();
  source.entrants.push({ id: "c", name: "C팀", members: [] }, { id: "d", name: "D팀", members: [] });
  const [first, second, final] = template.slots;
  first.seedA = "a"; first.seedB = "b"; second.seedA = "c"; second.seedB = "d";
  source.input.slots = template.slots; source.input.routes = template.routes;
  source.input.games = [[first.id, "a", "b"], [second.id, "c", "d"], [final.id, "c", "a"]].flatMap(([slotId, win, loss], i) =>
    [0, 1].map((set) => ({ ...game(`${i}-${set}`, win, loss), slotId })));
  const result = fcoEventResult(source)!;
  assert.equal(result.label, "결승 스코어");
  assert.deepEqual(result.sides.map((s) => [s.name, s.score]), [["A팀", 0], ["C팀", 2]]);
});
