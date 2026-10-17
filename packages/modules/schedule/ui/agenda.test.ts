import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicScheduleEntry } from "@soop-lol/core/lib/contract/schedule";
import { agendaCards, agendaEntries, agendaRange, featuredCard, parseKind, tournamentEntries, weekStart } from "./agenda.ts";

const entry = (title: string, dates: string[], changes: Partial<PublicScheduleEntry> = {}): PublicScheduleEntry => ({
  schedule_id: title, game_code: "fconline", title, planned_format: "tournament", status: "scheduled", origin: "manual",
  sponsor: null, description: null, participants: [], sources: [], result: null, slots_changed_at: null, pending: false,
  slots: dates.map((on_date) => ({ on_date, starts_at: null, ends_at: null, label: null, channel_id: null })), ...changes,
});

test("월간 탐색: 월 경계의 날짜까지 표시", () => {
  assert.equal(weekStart("2026-10-18"), "2026-10-12");
  assert.equal(weekStart("2027-01-01"), "2026-12-28");
  assert.deepEqual(agendaRange("2026-03-01"), { from: "2026-02-23", to: "2026-04-05" });
  assert.deepEqual(agendaRange("2027-02-01"), { from: "2027-02-01", to: "2027-02-28" });
  assert.deepEqual(agendaRange("2026-10-13"), { from: "2026-09-28", to: "2026-11-01" });
});

test("대회는 기간을 연결하되 일별 목록은 공지된 경기일만 표시", () => {
  const league = entry("리그", ["2026-10-09", "2026-10-11", "2026-10-18"]);
  const cards = agendaCards([league], "2026-10-12", "2026-10-18");
  assert.deepEqual(cards.map((c) => c.slot.on_date), ["2026-10-18"]);
  assert.equal(tournamentEntries([league], "2026-10-13").length, 1);
});

test("헤드라인: 가까운 유효 일정 우선, 취소·연기를 다음 경기로 추천하지 않음", () => {
  const recent = entry("최근", ["2026-10-11"], { status: "held" });
  const cancelled = entry("취소", ["2026-10-14"], { status: "cancelled" });
  const postponed = entry("연기", ["2026-10-15"], { status: "postponed" });
  const next = entry("다음", ["2026-10-18"]);
  const cards = agendaCards([recent, cancelled, postponed, next], "2026-10-09", "2026-10-22");
  assert.equal(featuredCard(cards, "2026-10-13")?.entry.title, "다음");
  assert.equal(featuredCard(cards.slice(0, 3), "2026-10-13")?.entry.title, "최근");
  assert.equal(featuredCard([], "2026-10-13"), undefined);
});

test("대회 분류는 날짜 수와 독립적이며 참가자·라운드 검색을 지원", () => {
  const cup = entry("하루 대회", ["2026-10-13"], { participants: [{ slug: "kim", display_name: "김민교", role: "host", team: null }] });
  const ck = entry("이틀 CK", ["2026-10-13", "2026-10-14"], { planned_format: "ck" });
  assert.deepEqual(tournamentEntries([ck, cup], "2026-10-13").map((e) => e.title), ["하루 대회"]);
  assert.deepEqual(agendaEntries([cup, ck], "tournament", "김 민교").map((e) => e.title), ["하루 대회"]);
  assert.deepEqual(agendaEntries([cup, ck], "ck", "김민교"), []);
});

test("유형 필터는 진행 방식 어휘만 읽는다 — 옛 값·모르는 값은 필터 없음", () => {
  assert.equal(parseKind("ck"), "ck");
  assert.equal(parseKind("concept"), "concept");
  assert.equal(parseKind("unclassified"), "unclassified");
  assert.equal(parseKind("showmatch"), null);
  assert.equal(parseKind("other"), null);
  assert.equal(parseKind(undefined), null);
});
