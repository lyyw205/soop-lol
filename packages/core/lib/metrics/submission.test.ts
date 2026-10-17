import { test } from "node:test";
import assert from "node:assert/strict";

import { matchStreamerNames, normalizeScheduleReport, scheduleReportHasChange, submissionLines } from "./submission.ts";

const names = { streamer: (id: string) => id, champion: (id: number) => String(id) };

test("편성표 제보 정규화 — 빈 칸을 지우고 제목 공백·참가자 중복을 정리한다", () => {
  assert.deepEqual(normalizeScheduleReport({ type: "correction", title: "  멸망전   결승 ", status: "", participants: "가, 나\n가 ,  " }),
    { type: "correction", title: "멸망전 결승", participants: "가, 나" });
  assert.equal(scheduleReportHasChange({ type: "correction" }), false);
  assert.equal(scheduleReportHasChange({ type: "new" }), true);
});

test("편성표 제보 정규화 — 새 일정은 게임·제목·날짜, 시각은 날짜와 함께, 없는 날짜는 거부", () => {
  assert.throws(() => normalizeScheduleReport({ type: "new", game_code: "lol", title: "x" }), /날짜/);
  assert.throws(() => normalizeScheduleReport({ type: "new", game_code: "lol", title: "x", on_date: "2026-02-30" }), /없는 날짜/);
  assert.throws(() => normalizeScheduleReport({ type: "correction", start: "20:00" }), /날짜도/);
  assert.throws(() => normalizeScheduleReport({ type: "new", game_code: "lol", title: "x", on_date: "2026-11-01", status: "cancelled" }), /상태/);
  assert.deepEqual(normalizeScheduleReport({ type: "correction", on_date: "2026-11-01", start: "" }), { type: "correction", on_date: "2026-11-01", start: null });
});

test("이름 → 스트리머는 표시 이름·slug 와 정확히 같은 것만(대소문자 무시), 같은 사람은 한 번", () => {
  const streamers = [{ slug: "faker", display_name: "페이커" }, { slug: "zeus", display_name: "제우스" }];
  assert.deepEqual(matchStreamerNames("페이커, FAKER, 제우, 모르는사람", streamers), { slugs: ["faker"], unmatched: ["제우", "모르는사람"] });
  assert.deepEqual(matchStreamerNames("", streamers), { slugs: [], unmatched: [] });
});

test("읽는 줄은 종류로 갈린다", () => {
  assert.deepEqual(submissionLines({ kind: "schedule_report", payload: { type: "correction", status: "cancelled" } }, names), ["일정 고치기", "상태: 취소"]);
  assert.deepEqual(submissionLines({ kind: "match_correction", payload: { winning_team: { from: 100, to: 200 } } }, names), ["승리 팀: 블루 → 레드"]);
});
