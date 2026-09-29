import assert from "node:assert/strict";
import { test } from "node:test";

import { projectReviewQueue, reviewQueueEntries, UNPLACED } from "./ck-review-queue.ts";

const frame = (id: string, at_sec: number, match_id: string | null = null) => ({ id, at_sec, match_id });
const match = (match_id: string) => ({ match_id });

test("경기 범위에는 그 경기에 연결된 프레임만 모은다", () => {
  const projection = projectReviewQueue(
    [frame("m1-late", 23119, "M1"), frame("m1-early", 23023, "M1"), frame("orphan", 23160), frame("m2", 23400, "M2")],
    [match("M1"), match("M2")],
  );
  assert.deepEqual(projection.map((item) => item.match.match_id), ["M1", "M2"]);
  assert.deepEqual(projection[0].frames.map((f) => f.id), ["m1-early", "m1-late"]);
  assert.deepEqual(projection[1].frames.map((f) => f.id), ["m2"]);
});

test("미연결 프레임은 경기 사이에 표시하고, 시각 미상과 경기 없는 VOD 도 유지한다", () => {
  const frames = [frame("late", 300), frame("m", 200, "M"), frame("early", 100),
    { id: "unknown", match_id: null, at_sec: null }];
  const entries = reviewQueueEntries(projectReviewQueue(frames, [match("M")]), frames);
  assert.deepEqual(entries.map(e => [e.kind, e.id]), [
    ["frame", "early"], ["match", "M"], ["frame", "late"], ["frame", "unknown"],
  ]);
  assert.equal(reviewQueueEntries([], [frame("only", 10)]).length, 1);
});

test("구간 안의 작은 미연결 프레임도 볼 수 있고, 경계 중복과 프레임 누락이 없다", () => {
  const frames = [frame("outside", 50), frame("start", 100, "M1"), frame("small", 150),
    frame("end", 200, "M1"), frame("boundary", 200), frame("next", 200, "M2"),
    frame("next-end", 300, "M2"), { id: "unknown", at_sec: null, match_id: null }];
  const projection = projectReviewQueue(frames, [match("M1"), match("M2")]);
  assert.deepEqual(projection[0].frames.map(f => f.id), ["start", "small", "end"]);
  assert.deepEqual(projection[1].frames.map(f => f.id), ["next", "boundary", "next-end"]);
  const entries = reviewQueueEntries(projection, frames);
  assert.deepEqual(entries.filter(e => e.kind === "frame").map(e => e.id), ["outside", "unknown"]);
  const reachable = entries.flatMap(e => e.kind === "frame" ? [e.id] : e.item.frames.map(f => f.id));
  assert.equal(reachable.length, frames.length);
  assert.deepEqual([...new Set(reachable)].sort(), frames.map(f => f.id).sort());
  assert.equal(frames.find(f => f.id === "small")!.match_id, null, "화면에 묶어도 DB 연결을 추정하지 않는다");
});

test("경기 폭은 연결 프레임, 확인된 VOD 시작 시각 순으로 고른다", () => {
  const fromEvidence = projectReviewQueue([frame("a", 200, "M"), frame("b", 240, "M")], [match("M")])[0];
  assert.deepEqual({ at: fromEvidence.at, end: fromEvidence.end, source: fromEvidence.rangeSource },
    { at: 200, end: 240, source: "evidence" });

  const fromGameTime = projectReviewQueue(
    [], [{ match_id: "M", game_creation: "2026-09-20T01:00:00Z", game_duration: 1800 }],
    { vodStartedAt: "2026-09-20T00:00:00Z" },
  )[0];
  assert.deepEqual({ at: fromGameTime.at, end: fromGameTime.end, source: fromGameTime.rangeSource },
    { at: 3600, end: 5400, source: "game_time" });
});

test("프레임도 확인된 VOD 시작 시각도 없는 경기는 시각 미상으로 남는다", () => {
  const projection = projectReviewQueue(
    [], [{ match_id: "manual", game_creation: "2026-09-20T01:00:00Z", game_duration: 1800 }],
  );
  assert.equal(projection.length, 1);
  assert.equal(projection[0].at, UNPLACED);
  assert.equal(projection[0].rangeSource, "unknown");
});

test("다음 경기가 시작된 뒤 남은 늦은 결과 프레임은 앞 경기 막대를 겹치게 하지 않는다", () => {
  const projection = projectReviewQueue(
    [frame("game-end", 16812, "M1"), frame("late-result", 16940, "M1"), frame("m2-start", 16900, "M2"), frame("m2-end", 19680, "M2")],
    [match("M1"), match("M2")],
  );
  assert.deepEqual(projection.map((item) => ({ id: item.match.match_id, at: item.at, end: item.end })), [
    { id: "M1", at: 16812, end: 16900 },
    { id: "M2", at: 16900, end: 19680 },
  ]);
  assert.deepEqual(projection[0].frames.map((item) => item.id), ["game-end", "late-result"], "늦은 프레임도 비교 프레임으로 남는다");
});
