import { test } from "node:test";
import assert from "node:assert/strict";

import { additionLines, additionOverlap, additionSetTime, isSameSeriesCandidate, normalizeMatchAddition } from "./addition.ts";

const S = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const base = {
  event_id: "", on_date: "2026-10-16", start: "20:30", map: "rift",
  teams: { a: [{ streamer_id: S(1) }, { name: " 일반인  하나 " }, {}], b: [{ streamer_id: S(2) }, { streamer_id: S(3) }] },
  sets: [{ a_side: 100, winner: "a", stats: { a0: { champion_id: 103, kills: "3", deaths: 1, assists: "" }, a2: { kills: 1 }, b1: {} } },
    { a_side: "200", winner: "b" }],
};

test("직접 입력 정규화 — 빈 자리·빈 통계를 지우고 이름 공백을 정리한다, 행사 모름은 null", () => {
  const a = normalizeMatchAddition(base, 209748301);
  assert.deepEqual(a, {
    event_id: null, on_date: "2026-10-16", start: "20:30", map: "rift", vod: 209748301,
    teams: { a: [{ streamer_id: S(1) }, { name: "일반인 하나" }], b: [{ streamer_id: S(2) }, { streamer_id: S(3) }] },
    sets: [{ a_side: 100, winner: "a", stats: { a0: { champion_id: 103, kills: 3, deaths: 1 } } }, { a_side: 200, winner: "b" }],
  });
  assert.equal(additionSetTime(a, 1).toISOString(), "2026-10-16T12:10:00.000Z");   // 20:30 KST + 40분
  assert.ok(additionLines(a, { streamer: (id) => id.slice(-1), champion: (id) => `#${id}` }).includes("1세트: A팀 블루 · A팀 승 · 1 #103 3/1/?"));
});

test("직접 입력 거부 — 등록 스트리머 2명 미만·같은 사람 두 번·승리 팀 없음·없는 챔피언·KDA 범위", () => {
  const bad = (patch: Record<string, unknown>, msg: RegExp) => assert.throws(() => normalizeMatchAddition({ ...base, ...patch }, null), msg);
  bad({ teams: { a: [{ streamer_id: S(1) }], b: [{ name: "x" }] } }, /2명 이상/);
  bad({ teams: { a: [{ streamer_id: S(1) }], b: [{ streamer_id: S(1) }, { streamer_id: S(2) }] } }, /두 번/);
  bad({ sets: [{ a_side: 100 }] }, /승리 팀/);
  bad({ sets: [{ a_side: 100, winner: "a", stats: { a0: { champion_id: 99999 } } }] }, /없는 챔피언/);
  bad({ sets: [{ a_side: 100, winner: "a", stats: { a0: { kills: 120 } } }] }, /0~99/);
  bad({ on_date: "2026-02-30" }, /날짜/);
  bad({ start: "" }, /시작 시각/);
  bad({ sets: [] }, /세트를 하나 이상/);
});

test("같은 시리즈 후보 — 같은 편으로 겹치는 등록 스트리머 수(두 짝 중 큰 쪽), 기준은 min(3, 고른 수)", () => {
  const mine = { a: ["A", "B"], b: ["C", "D"] };
  assert.equal(additionOverlap(mine, { 100: ["C", "D", "x"], 200: ["A", "B"] }), 4);   // 진영이 뒤집혀도 같은 편
  assert.equal(isSameSeriesCandidate(mine, { 100: ["A", "C"], 200: ["B", "D"] }), false);  // 편이 섞이면 2명뿐
  assert.equal(isSameSeriesCandidate(mine, { 100: ["A", "B", "q"], 200: ["D"] }), true);
  assert.equal(isSameSeriesCandidate({ a: ["A"], b: ["B"] }, { 100: ["A"], 200: ["B"] }), true);   // 고른 게 둘이면 둘 다
  assert.equal(isSameSeriesCandidate({ a: ["A"], b: ["B"] }, { 100: ["A", "B"], 200: [] }), false);
});
