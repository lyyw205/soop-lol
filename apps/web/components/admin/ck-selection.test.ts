import assert from "node:assert/strict";
import { test } from "node:test";

import { framesForSelection, representativeFrame, resolveSelection, timelineSpan } from "./ck-selection.ts";
import { projectReviewQueue } from "./ck-review-queue.ts";

const frame = (id: string, over: Partial<{ match_id: string | null; at_sec: number | null; kind: "result" | "roster" | "other" }> = {}) => ({
  id, match_id: null, at_sec: null, kind: "other" as const, ...over,
});

test("경기가 없는 VOD 도 미연결 프레임을 처음부터 볼 수 있다", () => {
  const sel = resolveSelection([frame("orphan")], []);
  assert.equal(sel.frame?.id, "orphan");
  assert.equal(sel.match, null);
});

test("구간 안의 미연결 사진을 넘겨도 선택한 큐와 좌우 탐색 범위가 유지된다", () => {
  const frames = [frame("start", { match_id: "M1", at_sec: 100 }), frame("small", { at_sec: 150 }),
    frame("end", { match_id: "M1", at_sec: 200 }), frame("outside", { at_sec: 250 })];
  const matches = [{ match_id: "M1" }];
  const projection = projectReviewQueue(frames, matches);
  const selected = resolveSelection(frames, matches, { matchId: "M1", frameId: "small" });
  assert.equal(selected.frame?.id, "small");
  assert.equal(selected.match?.match_id, "M1");
  assert.deepEqual(framesForSelection(frames, selected, projection).map(f => f.id), ["start", "small", "end"]);
  const outside = resolveSelection(frames, matches, { frameId: "outside" });
  assert.deepEqual(framesForSelection(frames, outside, projection).map(f => f.id), ["outside"]);
});

test("좌우 탐색 범위는 선택 경기의 프레임뿐이고 미연결 항목에서는 그 사진 하나뿐이다", () => {
  const frames = [frame("before", { at_sec: 1 }), frame("last", { match_id: "M1", at_sec: 30 }),
    frame("first", { match_id: "M1", at_sec: 10 }), frame("other", { match_id: "M2", at_sec: 40 }),
    frame("after", { at_sec: 50 })];
  const matches = [{ match_id: "M1" }, { match_id: "M2" }];
  for (const id of ["first", "last"]) {
    const scope = framesForSelection(frames, resolveSelection(frames, matches, { frameId: id }));
    assert.deepEqual(scope.map(f => f.id), ["first", "last"]);
    assert.equal(resolveSelection(frames, matches, { frameId: scope[0].id }).match?.match_id, "M1");
    assert.equal(resolveSelection(frames, matches, { frameId: scope.at(-1)!.id }).match?.match_id, "M1");
  }
  assert.deepEqual(framesForSelection(frames, resolveSelection(frames, matches, { frameId: "before" }))
    .map(f => f.id), ["before"]);
  assert.deepEqual(framesForSelection(frames, resolveSelection(frames, [{ match_id: "empty" }])), []);
});

test("경기 사이 미연결 프레임에서는 다른 경기의 편집기를 표시하지 않는다", () => {
  const frames = [frame("a", { match_id: "M1" }), frame("gap"), frame("b", { match_id: "M2" })];
  const matches = [{ match_id: "M1" }, { match_id: "M2" }];
  assert.equal(resolveSelection(frames, matches, { frameId: "a" }).match?.match_id, "M1");
  assert.equal(resolveSelection(frames, matches, { frameId: "gap" }).match, null);
  assert.equal(resolveSelection(frames, matches, { frameId: "b" }).match?.match_id, "M2");
  frames[1].match_id = "M2";
  assert.equal(resolveSelection(frames, matches, { frameId: "gap" }).match?.match_id, "M2");
  frames[1].match_id = null;
  const detached = resolveSelection(frames, matches, { frameId: "gap" });
  assert.equal(detached.frame?.id, "gap");
  assert.equal(detached.match, null);
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

// 선택 상태는 하나다 — 경기를 고른 채 미연결 사진을 넘겨 봐도 경기(=편집 대상)가 유지되고,
// 넘기는 범위는 그 사진 한 장이다. (예전엔 편집 대상을 따로 들고 있어 둘이 어긋나며 예외가 늘었다.)
test("경기를 고른 채 미연결 사진을 봐도 선택된 경기는 그대로고 사진만 바뀐다", () => {
  const frames = [
    { id: "f1", match_id: "M1", at_sec: 10, kind: "result" as const },
    { id: "u1", match_id: null, at_sec: 500, kind: "other" as const },
  ];
  const matches = [{ match_id: "M1" }, { match_id: "M2" }];
  const sel = resolveSelection(frames, matches, { matchId: "M2", frameId: "u1" });
  assert.equal(sel.match?.match_id, "M2");
  assert.equal(sel.frame?.id, "u1");
  assert.deepEqual(framesForSelection(frames, sel).map(f => f.id), ["u1"]);
  // 같은 경기 사진이면 그 경기의 사진 전체를 넘긴다.
  const same = resolveSelection(frames, matches, { matchId: "M1", frameId: "f1" });
  assert.deepEqual(framesForSelection(frames, same).map(f => f.id), ["f1"]);
});
