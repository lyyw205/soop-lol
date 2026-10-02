import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScheduleWindow } from "./load-window.ts";

test("추가 조회 — 잘못된 날짜·역전 기간·과도한 범위를 DB 호출 전에 거부", async () => {
  const base = { from: "2026-10-01", to: "2026-10-07", game: null, streamer: null };
  await assert.rejects(loadScheduleWindow({ ...base, from: "2026-02-30" }), /날짜/);
  await assert.rejects(loadScheduleWindow({ ...base, to: "2026-09-30" }), /14일/);
  await assert.rejects(loadScheduleWindow({ ...base, to: "2026-10-15" }), /14일/);
  await assert.rejects(loadScheduleWindow({ ...base, streamer: "bad/slug" }), /스트리머/);
});
