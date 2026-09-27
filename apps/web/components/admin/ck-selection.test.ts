import assert from "node:assert/strict";
import { test } from "node:test";

import { representativeFrame, resolveSelection, timelineSpan } from "./ck-selection.ts";

const frame = (id: string, over: Partial<{ match_id: string | null; at_sec: number | null; kind: "result" | "roster" | "other" }> = {}) => ({
  id, match_id: null, at_sec: null, kind: "other" as const, ...over,
});

test("★★ 근거 프레임이 없는 경기도 **고를 수 있다** — 보이기만 하고 못 고치면 검수가 아니다", () => {
  const matches = [{ match_id: "M1" }];
  assert.equal(resolveSelection([], matches).match?.match_id, "M1", "처음 열었을 때 첫 경기를 띄운다");
  assert.equal(resolveSelection([], matches, { matchId: "M1" }).match?.match_id, "M1", "직접 고른 경기가 뜬다");
});

test("프레임을 고르면 그 프레임이 붙은 경기가 뜬다", () => {
  const frames = [frame("f1", { match_id: "M1", at_sec: 150 })];
  const sel = resolveSelection(frames, [{ match_id: "M1" }], { frameId: "f1" });
  assert.equal(sel.frame?.id, "f1");
  assert.equal(sel.match?.match_id, "M1");
});

test("경기만 고르면 그 경기의 결과창을 비교 프레임으로 같이 띄운다", () => {
  const frames = [frame("r", { match_id: "M1", at_sec: 10 }), frame("res", { match_id: "M1", at_sec: 20, kind: "result" })];
  assert.equal(resolveSelection(frames, [{ match_id: "M1" }], { matchId: "M1" }).frame?.id, "res");
  assert.equal(representativeFrame(frames, "M2"), null);
});

test("★ 다른 경기로 옮겨 붙은 프레임을 고르면 그 경기가 뜬다 — 첫 경기로 슬쩍 되돌아가지 않는다", () => {
  const frames = [frame("f1", { match_id: "M2", at_sec: 150 })];
  assert.equal(resolveSelection(frames, [{ match_id: "M1" }, { match_id: "M2" }], { frameId: "f1" }).match?.match_id, "M2");
});

test("★ timelineSpan — 프레임이 없어도 경기 범위로 축이 선다", () => {
  assert.equal(timelineSpan([], [[0, 9000]]), 9000);
  assert.equal(timelineSpan([{ at_sec: 120 }]), 120);
  assert.equal(timelineSpan([], []), 1, "아무것도 없으면 0 으로 나누지 않게 1");
});
