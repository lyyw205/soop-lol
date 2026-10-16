import { test } from "node:test";
import assert from "node:assert/strict";
import { fcoPlayerAppearance } from "./player-record.ts";
test("미출전과 평점 없는 출전을 구분하고 0 평점을 평균에 넣지 않는다", () => {
  assert.deepEqual(fcoPlayerAppearance({ spRating: 0, goal: 0 }), { appeared: false, rating: null });
  assert.deepEqual(fcoPlayerAppearance({ spRating: 0, goal: 1 }), { appeared: true, rating: null });
  assert.deepEqual(fcoPlayerAppearance({ assist: 1 }), { appeared: true, rating: null });
  assert.deepEqual(fcoPlayerAppearance({ spRating: 7.5 }), { appeared: true, rating: 7.5 });
  assert.deepEqual(fcoPlayerAppearance({ spRating: NaN }), { appeared: false, rating: null });
});
