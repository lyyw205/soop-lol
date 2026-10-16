import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_OPPONENT_SORT, isOpponentSort, sortOpponents, versusRecord } from "./opponents.ts";
import type { Counts } from "./tally.ts";

const c = (win = 0, loss = 0, draw = 0, unknown = 0): Counts => ({ win, draw, loss, unknown });
/** 세트 수와 시리즈 전적을 따로 준다 — 판수순은 세트, 승률순은 시리즈로 센다. */
const r = (name: string, o: Partial<{ sets: number; w: number; l: number; d: number; u: number; at: string }> = {}) => ({
  name,
  record: { sets: c(o.sets ?? 0), series: c(o.w ?? 0, o.l ?? 0, o.d ?? 0, o.u ?? 0) },
  last_met: o.at ?? "2020-01-01",
});

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

test("판수순 — 만난 세트가 많은 순", () => {
  const rows = [r("적게", { sets: 2 }), r("많이", { sets: 8 }), r("중간", { sets: 4 })];
  assert.deepEqual(names(sortOpponents(rows, "games")), ["많이", "중간", "적게"]);
});

test("최신순 — 마지막으로 만난 날", () => {
  const rows = [
    r("옛날", { sets: 9, at: "2019-05-01" }),
    r("최근", { sets: 1, at: "2026-08-01" }),
    r("중간", { sets: 5, at: "2023-01-01" }),
  ];
  assert.deepEqual(names(sortOpponents(rows, "recent")), ["최근", "중간", "옛날"]);
});

test("★ 승률순은 생 승률이 아니라 축소된 지수로, 시리즈 전적으로 한다", () => {
  // 1승 0패(생 100%)가 20승 5패(생 80%)를 이기면 그 목록은 거짓말이다.
  const rows = [r("한판승", { sets: 1, w: 1 }), r("스무판", { sets: 25, w: 20, l: 5 })];
  assert.deepEqual(names(sortOpponents(rows, "winrate")), ["스무판", "한판승"]);
});

test("★ 승부를 가린 시리즈가 없는 상대(미상·무만)는 승률순에서 맨 뒤로 간다", () => {
  const rows = [
    r("미상만", { sets: 3, u: 3 }),
    r("반타작", { sets: 10, w: 5, l: 5 }),
    r("잘이김", { sets: 10, w: 8, l: 2 }),
  ];
  assert.deepEqual(names(sortOpponents(rows, "winrate")), ["잘이김", "반타작", "미상만"]);
  assert.deepEqual(names(sortOpponents(rows, "winrate_asc")), ["반타작", "잘이김", "미상만"]);
});

test("★ 미상은 패로 세지 않는다 — 승률의 분모에서 뺀다", () => {
  assert.deepEqual(versusRecord(r("x", { w: 2, l: 1, d: 1, u: 4 })), { wins: 2, draws: 1, losses: 1 });
});

test("주소의 정렬 값 확인", () => {
  assert.equal(isOpponentSort("winrate"), true);
  assert.equal(isOpponentSort("없음"), false);
  assert.equal(DEFAULT_OPPONENT_SORT, "games");
});

test("무승부는 승률 분모에서 빠진다", () => {
  // 1승 1무 는 50% 가 아니라 100% 다 — 무승부는 진 게 아니다.
  const rows = [r("무승부낀쪽", { sets: 2, w: 1, d: 1 }), r("반타작", { sets: 2, w: 1, l: 1 })];
  assert.deepEqual(names(sortOpponents(rows, "winrate")), ["무승부낀쪽", "반타작"]);
});

test("원본 배열을 건드리지 않는다", () => {
  const rows = [r("a", { sets: 1 }), r("b", { sets: 9 })];
  sortOpponents(rows, "games");
  assert.deepEqual(names(rows), ["a", "b"]);
});
