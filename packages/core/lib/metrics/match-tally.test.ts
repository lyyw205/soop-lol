import { test } from "node:test";
import assert from "node:assert/strict";
import { tallyGroup, tallyGroups, matchOutcome } from "./match-tally.ts";

test("a series counts once by majority; an exact half is a draw", () => {
  assert.deepEqual(tallyGroup({ sets: 3, wins: 2, land: false }), { matches: 1, wins: 1, draws: 0, losses: 0 });
  assert.deepEqual(tallyGroup({ sets: 2, wins: 1, land: false }), { matches: 1, wins: 0, draws: 1, losses: 0 });
  assert.deepEqual(tallyGroup({ sets: 5, wins: 2, land: false }), { matches: 1, wins: 0, draws: 0, losses: 1 });
});

test("a land session counts every game as its own match", () => {
  assert.deepEqual(tallyGroup({ sets: 10, wins: 4, land: true }), { matches: 10, wins: 4, draws: 0, losses: 6 });
  assert.deepEqual(tallyGroups([{ sets: 10, wins: 4, land: true }, { sets: 3, wins: 2, land: false }]),
    { matches: 11, wins: 5, draws: 0, losses: 6 });
});

test("랜드 5승 5패에는 묶음 무승부 판정이 없다", () => {
  assert.equal(matchOutcome(5, 10, true), "record");
  assert.deepEqual(tallyGroup({ sets: 10, wins: 5, land: true }), { matches: 10, wins: 5, draws: 0, losses: 5 });
});
