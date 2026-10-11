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

test("시리즈 미지정: 묶지 않은 수기 경기는 단판이라고 부르지 않는다 — 확인된 단판(best_of=1)과 구별", () => {
  assert.equal(setLabel({ ...base, standalone: true, unassigned: true }), "시리즈 미지정");
  assert.equal(setLabel({ ...base, standalone: true, unassigned: false }), "단판", "넘기지 않으면 예전대로(공개 큐 단독 경기)");
  assert.equal(setLabel({ ...base, standalone: true, best_of: 1 }), "단판", "단판으로 확인한 경기(경기 ID 키 시리즈 + best_of=1)");
  assert.equal(setLabel({ ...base, unassigned: true, set_role: "bonus" }), "보너스", "보너스 판 이름이 먼저");
});
