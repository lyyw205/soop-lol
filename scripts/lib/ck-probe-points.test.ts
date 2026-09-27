import { test } from "node:test";
import assert from "node:assert/strict";

import { dividedPoints } from "./ck-probe-points.mjs";

test("dividedPoints는 양끝을 포함해 구간을 지정한 수로 나눈다", () => {
  assert.deepEqual(dividedPoints(100, 200, 5), [100, 120, 140, 160, 180, 200]);
});

test("dividedPoints는 짧은 정수 초 구간의 중복 지점을 제거한다", () => {
  assert.deepEqual(dividedPoints(10, 13, 5), [10, 11, 12, 13]);
});

test("dividedPoints는 잘못된 분할 수를 거부한다", () => {
  assert.throws(() => dividedPoints(10, 20, 1), /2 이상의 정수/);
  assert.throws(() => dividedPoints(20, 10, 5), /올바른 구간/);
});
