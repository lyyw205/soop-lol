import assert from "node:assert/strict";
import { test } from "node:test";

import { isStandaloneSet, setLabel } from "./set-label.ts";

const base = { standalone: false, best_of: null, set_order_known: false, series_game_no: 2 };

test("순서를 확인한 시리즈만 N세트로 부른다", () => {
  assert.equal(setLabel({ ...base, set_order_known: true }), "2세트");
  assert.equal(setLabel(base), "세트");
});

test("수집한 세트가 하나뿐이어도 단판으로 단정하지 않는다 — Bo3 의 첫 판일 수 있다", () => {
  assert.equal(setLabel({ ...base, best_of: 3, series_game_no: 1 }), "세트");
  assert.equal(setLabel({ ...base, best_of: 1, series_game_no: 1 }), "단판");
});

test("시리즈가 없는 경기는 단판이다", () => {
  assert.equal(setLabel({ ...base, standalone: true }), "단판");
  assert.equal(isStandaloneSet("KR_1", null), true);
  assert.equal(isStandaloneSet("m:g03s1", "m:g03s1"), true);
  assert.equal(isStandaloneSet("m:g03s1", "m:g03"), false);
});
