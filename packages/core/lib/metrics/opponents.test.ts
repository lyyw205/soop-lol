import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_OPPONENT_SORT, isOpponentSort, sortOpponents, versusRecord } from "./opponents.ts";

const r = (
  name: string,
  o: Partial<{ vs: number; w: number; d: number; ally: number; at: string }> = {},
) => ({
  name,
  vs_matches: o.vs ?? 0,
  vs_match_wins: o.w ?? 0,
  vs_match_draws: o.d ?? 0,
  ally_matches: o.ally ?? 0,
  last_met: o.at ?? "2020-01-01",
});

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

test("판수순 — 맞붙은 판과 같은 팀 판을 합쳐 센다", () => {
  const rows = [r("적게", { vs: 2 }), r("많이", { vs: 3, ally: 5 }), r("중간", { vs: 4 })];
  assert.deepEqual(names(sortOpponents(rows, "games")), ["많이", "중간", "적게"]);
});

test("최신순 — 마지막으로 만난 날", () => {
  const rows = [
    r("옛날", { vs: 9, at: "2019-05-01" }),
    r("최근", { vs: 1, at: "2026-08-01" }),
    r("중간", { vs: 5, at: "2023-01-01" }),
  ];
  assert.deepEqual(names(sortOpponents(rows, "recent")), ["최근", "중간", "옛날"]);
});

test("★ 승률순은 생 승률이 아니라 축소된 지수로 한다", () => {
  // 1승 0패(생 100%)가 20승 5패(생 80%)를 이기면 그 목록은 거짓말이다.
  const rows = [r("한판승", { vs: 1, w: 1 }), r("스무판", { vs: 25, w: 20 })];
  assert.deepEqual(names(sortOpponents(rows, "winrate")), ["스무판", "한판승"]);
});

test("★ 맞붙은 적 없는 상대는 승률순에서 맨 뒤로 간다", () => {
  // 0판도 축소를 거치면 0.5 가 나온다. 그대로 두면 5할 상대들 사이에 앉는다.
  const rows = [
    r("같은팀만", { vs: 0, ally: 30 }),
    r("반타작", { vs: 10, w: 5 }),
    r("잘이김", { vs: 10, w: 8 }),
  ];
  assert.deepEqual(names(sortOpponents(rows, "winrate")), ["잘이김", "반타작", "같은팀만"]);
});

test("무승부는 승률 분모에서 빠진다", () => {
  // 1승 1무 는 50% 가 아니라 100% 다 — 무승부는 진 게 아니다.
  assert.deepEqual(versusRecord(r("x", { vs: 2, w: 1, d: 1 })), { wins: 1, draws: 1, losses: 0 });
  const rows = [r("무승부낀쪽", { vs: 2, w: 1, d: 1 }), r("반타작", { vs: 2, w: 1 })];
  assert.deepEqual(names(sortOpponents(rows, "winrate")), ["무승부낀쪽", "반타작"]);
});

test("원본 배열을 건드리지 않는다", () => {
  const rows = [r("a", { vs: 1 }), r("b", { vs: 9 })];
  sortOpponents(rows, "games");
  assert.deepEqual(names(rows), ["a", "b"]);
});

test("주소창에 아무거나 넣어도 기본값으로 간다", () => {
  assert.equal(isOpponentSort("winrate"), true);
  assert.equal(isOpponentSort("아무말"), false);
  assert.equal(isOpponentSort(undefined), false);
  assert.equal(DEFAULT_OPPONENT_SORT, "games");
});
