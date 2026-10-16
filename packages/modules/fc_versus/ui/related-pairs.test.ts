import assert from "node:assert/strict";
import { test } from "node:test";
import { relatedPairs } from "./related-pairs.ts";

const counts = (win: number, draw: number, loss: number, unknown = 0) => ({ win, draw, loss, unknown });

test("검색한 사람이 오른쪽에 있어도 본인을 왼쪽으로 옮기고 세트·시리즈 기록을 거울로 돌린다(무·미상 유지)", () => {
  const pair = { a_id: "other", b_id: "me", games: 9, record: { sets: counts(2, 1, 6), series: counts(1, 0, 3, 1) } };
  assert.deepEqual(relatedPairs([pair], "me", "current"), [
    { a_id: "me", b_id: "other", games: 9, record: { sets: counts(6, 1, 2), series: counts(3, 0, 1, 1) } },
  ]);
  assert.equal(pair.a_id, "other");
});

test("현재 상대와 무관한 전체 매치업을 제외하고 나머지 순위는 유지한다", () => {
  const pair = (a_id: string, b_id: string, games: number) => ({ a_id, b_id, games, record: { sets: counts(games, 0, 0), series: counts(games, 0, 0) } });
  const first = pair("me", "first", 7);
  const second = pair("me", "second", 3);
  assert.deepEqual(relatedPairs([
    pair("unrelated-a", "unrelated-b", 20), pair("current", "me", 12), first, second,
  ], "me", "current"), [first, second]);
  assert.deepEqual(relatedPairs([pair("unrelated-a", "unrelated-b", 20)], "me", "current"), []);
});
