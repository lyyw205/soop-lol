import assert from "node:assert/strict";
import { test } from "node:test";
import { relatedPairs } from "./related-pairs.ts";

test("검색한 사람이 오른쪽에 저장돼 있어도 본인과 승수를 왼쪽으로 옮기고 무승부는 유지한다", () => {
  const pair = { a_id: "other", b_id: "me", games: 9, a_wins: 2, b_wins: 6, draws: 1 };
  assert.deepEqual(relatedPairs([pair], "me", "current"), [
    { a_id: "me", b_id: "other", games: 9, a_wins: 6, b_wins: 2, draws: 1 },
  ]);
  assert.equal(pair.a_id, "other");
});

test("현재 상대와 무관한 전체 매치업을 제외하고 나머지 순위는 유지한다", () => {
  const pair = (a_id: string, b_id: string, games: number) => ({ a_id, b_id, games, a_wins: games, b_wins: 0, draws: 0 });
  const first = pair("me", "first", 7);
  const second = pair("me", "second", 3);
  assert.deepEqual(relatedPairs([
    pair("unrelated-a", "unrelated-b", 20), pair("current", "me", 12), first, second,
  ], "me", "current"), [first, second]);
  assert.deepEqual(relatedPairs([pair("unrelated-a", "unrelated-b", 20)], "me", "current"), []);
});
