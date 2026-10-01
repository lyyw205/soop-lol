import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicScheduleEntry } from "@soop-lol/core/lib/contract";

import { barSpan, cardsByDay, majorRows, windowDays } from "./layout.ts";

const entry = (title: string, slots: [string, string | null][]): PublicScheduleEntry => ({
  schedule_id: title, game_code: "lol", title, scale: "major", planned_kind: "tournament", sponsor: null, description: null,
  status: "scheduled", origin: "manual", participants: [], sources: [], result: null,
  slots: slots.map(([on_date, hhmm]) => ({
    label: null, on_date, ends_at: null, channel_id: null, starts_at: hhmm ? new Date(`${on_date}T${hhmm}:00+09:00`) : null,
  })),
});

test("창 날짜", () => {
  assert.deepEqual(windowDays("2026-10-30", 4), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
});

test("막대 — 창 안 / 앞뒤로 잘림 / 창 밖", () => {
  assert.deepEqual(barSpan({ from: "2026-10-03", to: "2026-10-05" }, "2026-10-01", 14), { start: 3, end: 5, cutStart: false, cutEnd: false });
  assert.deepEqual(barSpan({ from: "2026-09-20", to: "2026-10-30" }, "2026-10-01", 14), { start: 1, end: 14, cutStart: true, cutEnd: true });
  assert.equal(barSpan({ from: "2026-09-20", to: "2026-09-30" }, "2026-10-01", 14), null);
  assert.equal(barSpan({ from: "2026-10-15", to: "2026-10-20" }, "2026-10-01", 14), null);
});

test("대형 줄 — 기간 전에 시작한 대회도 겹치면 잘린 막대, 방송 있는 날만 진하게", () => {
  const [row] = majorRows([entry("멸망전", [["2026-09-28", "19:00"], ["2026-10-02", "19:00"], ["2026-10-20", null]])], "2026-10-01", 14);
  assert.deepEqual(row.span, { start: 1, end: 14, cutStart: true, cutEnd: true });
  assert.deepEqual(row.liveCols, [2], "창 안에 있는 방송 날만");
});

test("날짜 칸 — 시각 있는 것 먼저 시각순, 시각 미정은 뒤에", () => {
  const days = windowDays("2026-10-03", 1);
  const cards = cardsByDay([entry("나 미정", [["2026-10-03", null]]), entry("늦은", [["2026-10-03", "21:00"]]), entry("이른", [["2026-10-03", "18:00"]])], days);
  assert.deepEqual(cards.get("2026-10-03")!.map((c) => c.entry.title), ["이른", "늦은", "나 미정"]);
});

test("날짜 칸 — 창 밖 날짜의 칸은 버린다", () => {
  const cards = cardsByDay([entry("밖", [["2026-11-03", "18:00"]])], windowDays("2026-10-03", 2));
  assert.equal([...cards.values()].flat().length, 0);
});
