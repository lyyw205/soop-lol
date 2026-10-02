import assert from "node:assert/strict";
import { test } from "node:test";
import { adjacentMonth, calendarDays } from "./calendar.ts";

test("월간 달력 — 일요일 시작, 이전/다음 달 포함, 윤년 2월 29일 표시", () => {
  const leap = calendarDays("2024-02");
  assert.equal(leap.length, 42);
  assert.equal(leap[0], "2024-01-28");
  assert.ok(leap.includes("2024-02-29"));
  assert.equal(leap.at(-1), "2024-03-09");
  assert.equal(new Set(leap).size, 42);
  assert.equal(calendarDays("2026-02").filter((date) => date.startsWith("2026-02")).length, 28);
});

test("월 이동 — 연말·연초와 짧은 달을 정확히 이동", () => {
  assert.equal(adjacentMonth("2026-12", 1), "2027-01");
  assert.equal(adjacentMonth("2026-01", -1), "2025-12");
  assert.equal(adjacentMonth("2024-02", 1), "2024-03");
});
