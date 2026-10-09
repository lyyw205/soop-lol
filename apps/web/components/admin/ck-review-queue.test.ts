import assert from "node:assert/strict";
import { test } from "node:test";

import { projectReviewQueue, reviewQueueEntries, chronologicalReviewQueue, UNPLACED } from "./ck-review-queue.ts";

const frame = (id: string, at_sec: number, match_id: string | null = null) => ({ id, at_sec, match_id });
const match = (match_id: string) => ({ match_id });

test("메모장 묶음은 시작 시각에 따라 경기·미연결 프레임 사이에 놓이고 경기 필터에서는 빠진다", () => {
  const frames = [frame("early", 10), frame("one", 100, "M1"), frame("two", 200, "M2"),
    { id: "unknown", match_id: null, at_sec: null }];
  const projection = projectReviewQueue(frames, [match("M1"), match("M2")]);
  const memos = [{ key: "later-note", from: 150 }, { key: "early-note", from: 90 }, { key: "same-time", from: 100 }];
  const entries = chronologicalReviewQueue(projection, frames, memos);
  assert.deepEqual(entries.map(e => [e.kind, e.id]), [
    ["frame", "early"], ["memo", "early-note"], ["match", "M1"], ["memo", "same-time"],
    ["memo", "later-note"], ["match", "M2"], ["frame", "unknown"],
  ]);
  assert.deepEqual(chronologicalReviewQueue(projection, frames, memos, true).map(e => e.id), ["M1", "M2"]);
  assert.equal(chronologicalReviewQueue([], [], memos)[0].id, "early-note");
  assert.equal(memos[0].key, "later-note", "정렬이 원본 목록을 바꾸지 않는다");
  assert.equal(projection[0].frames.length, 1, "시각이 가까워도 메모장을 경기 근거로 연결하지 않는다");
});

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

test("결과창 한 장만 연결된 경기도 게임 길이만큼 앞의 밴픽·게임 화면을 그 경기에서 본다", () => {
  // 2026-10-08 다누리 9시 CK 1경기: 결과창(13388초) 한 장만 연결 → 좌우로 넘길 사진이 없었다.
  const frames = [frame("lobby-before", 10500), frame("banpick", 11700), frame("ingame", 12600),
    frame("result", 13388, "G1"), frame("g2-ingame", 15000), frame("g2-result", 16070, "G2")];
  const withDuration = (match_id: string, game_duration: number) => ({ match_id, game_duration });
  const projection = projectReviewQueue(frames, [withDuration("G1", 1800), withDuration("G2", 1676)]);
  assert.deepEqual(projection[0].frames.map(f => f.id), ["banpick", "ingame", "result"]);
  assert.deepEqual(projection[1].frames.map(f => f.id), ["g2-ingame", "g2-result"]);
  assert.equal(projection[0].at, 13388 - 1800 - 600);
  assert.deepEqual(reviewQueueEntries(projection, frames).filter(e => e.kind === "frame").map(e => e.id), ["lobby-before"]);
});
