import test from "node:test";
import assert from "node:assert/strict";
import { fcoMatchStartMs, fcoProbePlan, fcoVodOffsets } from "./timeline.ts";

test("matchId 앞 8자리는 경기 시작 유닉스 초다", () => {
  // 실측: 6a8d4fe0… = ROUND 1 킥오프 (VOD 205292057, 대기실 READY 가 30초 전에 보였다)
  assert.equal(new Date(fcoMatchStartMs("6a8d4fe066b9776fe4e71070")!).toISOString(), "2026-08-25T08:18:40.000Z");
  assert.equal(fcoMatchStartMs("xyz"), null);
});

test("VOD 초로 바꾸고, 종료가 VOD 밖이면 null", () => {
  const vod = { vod: 205292057, startMs: Date.parse("2026-08-25T16:00:20+09:00"), lengthSec: 14659 };
  const o = fcoVodOffsets({ provider_match_id: "6a8d4fe066b9776fe4e71070", played_at: "2026-08-25T08:29:37Z" }, vod);
  assert.deepEqual(o, { start: 4700, end: 5357 });
  assert.equal(fcoVodOffsets({ provider_match_id: "6a8d4fe066b9776fe4e71070", played_at: "2026-08-25T12:00:00Z" }, vod), null);
});

test("뽑을 지점 — 4종과 결과 화면 1차 구간", () => {
  const p = fcoProbePlan({ start: 4700, end: 5357 }, 14659);
  assert.deepEqual(p, { pre: 4670, start: 4715, end: 5367, post: 5402, result: [5337, 5417] });
  // 실측 결과 화면(5367, 「경기 하이라이트 2-3」)이 1차 구간 안에 있다
  assert.ok(5367 >= p.result[0] && 5367 <= p.result[1]);
});
