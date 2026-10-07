import { test } from "node:test";
import assert from "node:assert/strict";
import { tallyGroup, tallyGroups } from "./match-tally.ts";

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
