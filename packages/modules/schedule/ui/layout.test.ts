import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicScheduleEntry } from "@soop-lol/core/lib/contract";

import { barSpan, cardsByDay, timelineLanes, majorRows, windowDays, mergeScheduleEntries, expandedScrollLeft, centeredScrollLeft, WINDOW_LEAD_DAYS, WINDOW_DAYS, DAY_WIDTH } from "./layout.ts";

const entry = (title: string, slots: [string, string | null][]): PublicScheduleEntry => ({
  schedule_id: title, game_code: "lol", title, planned_kind: "tournament", sponsor: null, description: null,
  status: "scheduled", origin: "manual", participants: [], sources: [], result: null, slots_changed_at: null,
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

test("여러 날 행사 줄 — 기간 전에 시작한 대회도 겹치면 잘린 막대, 방송 있는 날만 진하게", () => {
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


test("일정 레인 — 겹치는 기간과 같은 날짜는 분리하고 끝난 레인을 재사용", () => {
  const a = entry("a", [["2026-10-01", null], ["2026-10-04", null]]);
  const b = entry("b", [["2026-10-03", null], ["2026-10-05", null]]);
  const c = entry("c", [["2026-10-04", "18:00"]]);
  const d = entry("d", [["2026-10-05", null]]);
  const result = timelineLanes([d, c, b, a], "2026-10-01");
  assert.equal(result.laneCount, 3);
  assert.deepEqual(result.bars.map(({entry, lane}) => [entry.title, lane]), [["a", 0], ["b", 1], ["c", 2], ["d", 0]]);
  assert.deepEqual(timelineLanes([a, b, c, d], "2026-10-01"), result, "입력 순서에 영향을 받지 않는다");
});

test("일정 레인 — 창 밖 제외, 잘린 기간 충돌, 빈 게임도 한 레인 유지", () => {
  const result = timelineLanes([
    entry("긴 행사", [["2026-09-20", null], ["2026-10-30", null]]),
    entry("하루", [["2026-10-02", null]]), entry("밖", [["2026-11-01", null]]),
  ], "2026-10-01");
  assert.equal(result.bars.length, 2);
  assert.equal(result.laneCount, 2);
  assert.equal(result.bars[0].span.cutStart, true);
  assert.equal(result.bars[0].span.cutEnd, true);
  assert.deepEqual(timelineLanes([], "2026-10-01"), { bars: [], laneCount: 1 });
});

test("읽기 공간 — 하루 일정도 제목 공간을 확보하되 실제 기간은 늘리지 않는다", () => {
  const { bars } = timelineLanes([
    entry("a", [["2026-10-01", null]]), entry("b", [["2026-10-02", null]]),
    entry("끝", [["2026-10-14", null]]),
  ], "2026-10-01", 14, 3);
  assert.deepEqual(bars[0].displaySpan, { start: 1, end: 3 });
  assert.equal(bars[0].span.end, 1);
  assert.notEqual(bars[0].lane, bars[1].lane, "날짜뿐 아니라 제목끼리도 겹치지 않는다");
  assert.deepEqual(bars[2].displaySpan, { start: 12, end: 14 });
  assert.equal(bars[2].span.start, 14, "창 끝에서는 제목만 왼쪽으로 옮긴다");
});

test("통합 타임라인 — 다른 게임도 겹치면 행을 나누고 빈 날짜는 행을 재사용", () => {
  const lol = entry("롤", [["2026-10-01", null], ["2026-10-03", null]]);
  const fc = { ...entry("FC", [["2026-10-02", null]]), game_code: "fconline" as const };
  const later = { ...entry("다음 FC", [["2026-10-07", null]]), game_code: "fconline" as const };
  const { bars, laneCount } = timelineLanes([lol, fc, later], "2026-10-01", 14, 3);
  assert.equal(laneCount, 2);
  assert.notEqual(bars[0].lane, bars[1].lane);
  assert.equal(bars[0].lane, bars[2].lane);
});


test("기간 확장 — 31일을 넘어도 날짜와 일정이 남고 경계 대회는 중복되지 않는다", () => {
  const old = entry("장기 대회", [["2026-10-01", null], ["2026-11-05", null]]);
  const updated = { ...old, title: "장기 대회 수정" };
  const next = entry("새 일정", [["2026-11-01", null]]);
  const merged = mergeScheduleEntries([old], [updated, next]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, "장기 대회 수정");
  const days = windowDays("2026-10-01", 42);
  assert.equal(days.at(-1), "2026-11-11");
  assert.equal(timelineLanes(merged, days[0], days.length, 2).bars.length, 2);
  assert.deepEqual(mergeScheduleEntries(merged, []), merged, "일정 없는 주를 추가해도 기존 데이터 유지");
});

test("왼쪽 확장 — 날짜 경계를 지나도 읽던 위치 유지, 오른쪽 추가는 위치 불변", () => {
  assert.equal(expandedScrollLeft("2026-10-03", "2026-09-26", 240, 160), 1360);
  assert.equal(expandedScrollLeft("2026-10-03", "2026-10-03", 240, 160), 240);
});


test("초기·날짜 이동 — 날짜 칸의 중앙을 데스크톱과 모바일 중앙에 맞춘다", () => {
  for (const viewport of [1200, 390]) {
    const left = centeredScrollLeft(7, 160, viewport, 2240);
    assert.equal(7 * 160 + 80 - left, viewport / 2);
  }
  assert.equal(centeredScrollLeft(0, 160, 1200, 2240), 0);
  assert.equal(centeredScrollLeft(13, 160, 1200, 2240), 1040);
});


test("초기 범위는 오늘 전 3일·후 7일이며 넓은 화면에서도 오늘은 중앙", () => {
  assert.equal(WINDOW_LEAD_DAYS, 3);
  assert.equal(WINDOW_DAYS, 11);
  const days = windowDays("2026-09-29");
  assert.equal(days[3], "2026-10-02");
  assert.equal(days.at(-1), "2026-10-09");
  for (const viewport of [1224, 390]) {
    const inset = Math.max(0, viewport / 2 - (WINDOW_LEAD_DAYS + .5) * DAY_WIDTH);
    const left = centeredScrollLeft(3, DAY_WIDTH, viewport, WINDOW_DAYS * DAY_WIDTH + inset * 2, inset);
    assert.equal(inset + 3.5 * DAY_WIDTH - left, viewport / 2);
  }
});
