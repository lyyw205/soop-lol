import assert from "node:assert/strict";
import { test } from "node:test";
import { compareMatches, fcoApiWindowStart, normalizeName, screenMatchId, screenOutcomes } from "./screen.ts";

const sig = (at: string, a: [string, number | null], b: [string, number | null]) =>
  ({ at: new Date(at).getTime(), sides: [{ key: a[0], score: a[1] }, { key: b[0], score: b[1] }] as [{ key: string; score: number | null }, { key: string; score: number | null }] });

test("같은 경기: 참가자·±3분·스코어가 모두 맞으면 same", () => {
  assert.equal(compareMatches(sig("2026-09-01T10:00:00Z", ["a", 2], ["b", 1]), sig("2026-09-01T10:02:00Z", ["b", 1], ["a", 2])), "same");
});
test("스코어를 못 읽었거나 시각이 3분을 넘으면 maybe(R3), 참가자·스코어가 어긋나면 no", () => {
  assert.equal(compareMatches(sig("2026-09-01T10:00:00Z", ["a", null], ["b", null]), sig("2026-09-01T10:00:30Z", ["a", 2], ["b", 1])), "maybe");
  assert.equal(compareMatches(sig("2026-09-01T10:00:00Z", ["a", 2], ["b", 1]), sig("2026-09-01T10:05:00Z", ["a", 2], ["b", 1])), "maybe");
  assert.equal(compareMatches(sig("2026-09-01T10:00:00Z", ["a", 2], ["b", 1]), sig("2026-09-01T10:00:00Z", ["a", 3], ["b", 1])), "no");
  assert.equal(compareMatches(sig("2026-09-01T10:00:00Z", ["a", 2], ["b", 1]), sig("2026-09-01T10:00:00Z", ["a", 2], ["c", 1])), "no");
  assert.equal(compareMatches(sig("2026-09-01T10:00:00Z", ["a", 2], ["b", 1]), sig("2026-09-01T11:00:00Z", ["a", 2], ["b", 1])), "no");
});
test("결과: 같은 점수·못 읽은 점수는 unknown, 직접 본 결과가 우선, 서로 모순이면 거부", () => {
  assert.deepEqual(screenOutcomes([{ nickname: "a", score: 2 }, { nickname: "b", score: 1 }]), ["win", "loss"]);
  assert.deepEqual(screenOutcomes([{ nickname: "a", score: 1 }, { nickname: "b", score: 1 }]), ["unknown", "unknown"]);
  assert.deepEqual(screenOutcomes([{ nickname: "a", score: null }, { nickname: "b", score: 1 }]), ["unknown", "unknown"]);
  assert.deepEqual(screenOutcomes([{ nickname: "a", score: 1 }, { nickname: "b", score: 1, outcome: "win" }]), ["loss", "win"]);
  assert.throws(() => screenOutcomes([{ nickname: "a", score: 1, outcome: "win" }, { nickname: "b", score: 1, outcome: "win" }]));
});
test("API 창은 한국 날짜 기준 오늘−30일 0시", () => {
  assert.equal(fcoApiWindowStart(new Date("2026-10-01T03:00:00Z")).toISOString(), "2026-08-31T15:00:00.000Z");
  assert.equal(fcoApiWindowStart(new Date("2026-10-01T16:00:00Z")).toISOString(), "2026-09-01T15:00:00.000Z"); // KST 10-02 01:00
});
test("경기 ID 는 (VOD, 초)로 정해지고 이름은 공백·전각을 정규화한다", () => {
  assert.equal(screenMatchId(1, 2), "fcs:1@2");
  assert.throws(() => screenMatchId(0, 2));
  assert.equal(normalizeName(" 베타 감독 "), "베타감독");
});
