import assert from "node:assert/strict";
import { test } from "node:test";

import { coveredSeconds, mergeRanges, subtractRanges } from "./ranges.ts";

test("mergeRanges — 겹치거나 맞닿으면 합친다", () => {
  assert.deepEqual(mergeRanges([[0, 100], [50, 200]]), [[0, 200]]);
  assert.deepEqual(mergeRanges([[0, 600], [601, 1200]]), [[0, 1200]], "1초 틈은 이어진 것이다");
  assert.deepEqual(mergeRanges([[0, 100], [500, 600]]), [[0, 100], [500, 600]]);
});

test("mergeRanges — 망가진 입력은 조용히 버린다 (jsonb 에서 온다)", () => {
  assert.deepEqual(mergeRanges([[0, 100], null, [5], "x", [300, 200]]), [[0, 100]]);
});

test("subtractRanges — 가운데를 빼면 둘로 갈린다", () => {
  assert.deepEqual(subtractRanges([[0, 100]], [[40, 60]]), [[0, 39], [61, 100]]);
});

test("subtractRanges — 통째로 덮이면 사라진다 (못 본 구간의 해소)", () => {
  assert.deepEqual(subtractRanges([[600, 900]], [[0, 40000]]), []);
});

test("subtractRanges — 안 겹치면 그대로", () => {
  assert.deepEqual(subtractRanges([[600, 900]], [[2000, 3000]]), [[600, 900]]);
});

test("subtractRanges — 한쪽 끝만 겹치면 남은 쪽만 남는다", () => {
  assert.deepEqual(subtractRanges([[600, 900]], [[500, 700]]), [[701, 900]]);
  assert.deepEqual(subtractRanges([[600, 900]], [[800, 1000]]), [[600, 799]]);
});

test("coveredSeconds — 겹친 구간을 두 번 세지 않는다", () => {
  assert.equal(coveredSeconds([[0, 100], [50, 200]]), 200);
});
