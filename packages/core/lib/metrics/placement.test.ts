import assert from "node:assert/strict";
import { test } from "node:test";

import { placementBucket, placementRank } from "./placement.ts";

test("우승·준우승", () => {
  assert.equal(placementRank("우승"), 1);
  assert.equal(placementRank("준우승"), 2);
});

test("N강 은 그 라운드까지 갔다는 뜻이다", () => {
  assert.equal(placementRank("4강"), 4);
  assert.equal(placementRank("8강"), 8);
  assert.equal(placementRank("10강"), 10);
});

test("★ 'N강 탈락' 을 예선 탈락으로 세지 않는다", () => {
  // 2025~2026 회차 범례가 '4강 탈락'·'8강 탈락' 이라고 쓴다.
  // `탈락` 만 보고 99 로 넘기면 4강까지 간 팀이 예선 탈락으로 집계된다.
  assert.equal(placementRank("4강 탈락"), 4);
  assert.equal(placementRank("8강 탈락"), 8);
  assert.equal(placementBucket(placementRank("4강 탈락")), "semi");
  assert.equal(placementBucket(placementRank("8강 탈락")), "quarter");
});

test("예선 탈락은 몇 차든 하나로 묶는다", () => {
  for (const l of ["1차 예선 탈락", "2차예선 탈락", "예선 6강 or 4강 탈락"]) {
    assert.equal(placementRank(l), 99, l);
    assert.equal(placementBucket(placementRank(l)), "qualifier", l);
  }
});

test("모르는 표기는 null 이다 — 억지로 숫자를 붙이지 않는다", () => {
  assert.equal(placementRank("본선"), 50);
  assert.equal(placementBucket(50), null);
  assert.equal(placementRank("아무말"), null);
  assert.equal(placementRank(null), null);
  assert.equal(placementRank(undefined), null);
  assert.equal(placementBucket(null), null);
});

test("공동 N위", () => {
  assert.equal(placementRank("공동3위"), 3);
  assert.equal(placementRank("5위"), 5);
});
