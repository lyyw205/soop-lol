import { test } from "node:test";
import assert from "node:assert/strict";

import { affinity, formatRecord, isSmallSample, mostFrequent, rawWinRate, nemesesAndPrey } from "./affinity.ts";

test("작은 표본은 0.5 쪽으로 당겨진다 — 3승 0패는 100% 가 아니다", () => {
  assert.equal(rawWinRate({ wins: 3, losses: 0 }), 1);
  // (3 + 4×0.5) / (3 + 4) = 5/7
  assert.equal(affinity({ wins: 3, losses: 0 }).toFixed(2), "0.71");
});

test("표본이 커지면 생 승률에 수렴한다", () => {
  const big = { wins: 200, losses: 50 };
  assert.ok(Math.abs(affinity(big) - rawWinRate(big)!) < 0.01);
});

test("맞대결이 없으면 정확히 사전확률", () => {
  assert.equal(affinity({ wins: 0, losses: 0 }), 0.5);
  assert.equal(rawWinRate({ wins: 0, losses: 0 }), null);
});

test("천적·밥은 표본이 모자란 상대를 후보에서 뺀다", () => {
  const records = [
    { opponent: "적은표본", wins: 0, losses: 1 }, // 1경기 — 천적이라 부르면 안 된다
    { opponent: "천적", wins: 1, losses: 9 },
    { opponent: "밥", wins: 9, losses: 1 },
    { opponent: "보통", wins: 5, losses: 5 },
  ];
  const { nemeses, prey } = nemesesAndPrey(records);
  assert.equal(nemeses[0].opponent, "천적");
  assert.equal(prey[0].opponent, "밥");
  assert.ok(!nemeses.some((r) => r.opponent === "적은표본"));
  assert.ok(!prey.some((r) => r.opponent === "적은표본"));
});

test("mostFrequent 는 승률이 아니라 횟수로 정렬한다", () => {
  const records = [
    { opponent: "가끔", wins: 2, losses: 0 },
    { opponent: "자주", wins: 10, losses: 12 },
  ];
  assert.equal(mostFrequent(records)[0].opponent, "자주");
});

test("isSmallSample 경계", () => {
  assert.equal(isSmallSample({ wins: 2, losses: 2 }), true); // 4경기
  assert.equal(isSmallSample({ wins: 3, losses: 2 }), false); // 5경기
});

test("formatRecord 는 표본이 작으면 그렇다고 말한다", () => {
  assert.equal(formatRecord({ wins: 3, losses: 1 }), "3승 1패 (75%) · 4경기 참고용");
  assert.equal(formatRecord({ wins: 9, losses: 1 }), "9승 1패 (90%)");
  assert.equal(formatRecord({ wins: 0, losses: 0 }), "맞대결 없음");
});
