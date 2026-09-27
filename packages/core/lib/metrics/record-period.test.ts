import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecordDate, recordPeriodLabel, resolveRecordPeriod, withinRecordPeriod } from "./record-period.ts";

/** 2026-09-23 12:00 KST. 기간 계산은 전부 KST 달력 날짜를 기준으로 한다. */
const NOW = new Date("2026-09-23T03:00:00Z");

test("달력에 없는 날짜는 날짜가 아니다", () => {
  assert.equal(isRecordDate("2026-09-23"), true);
  assert.equal(isRecordDate("2026-02-30"), false, "2월 30일은 없다");
  assert.equal(isRecordDate("2026-13-01"), false);
  assert.equal(isRecordDate("2026-9-3"), false, "자리를 채우지 않은 표기는 받지 않는다");
  assert.equal(isRecordDate("0000-01-01"), false);
  assert.equal(isRecordDate(""), false);
});

test("프리셋 기간은 오늘(KST)에서 거슬러 올라간다", () => {
  // '최근 1주' 는 오늘을 포함한 7일이다 — 23 − 6 = 17.
  assert.deepEqual(resolveRecordPeriod({ period: "1w" }, NOW), { key: "1w", from: "2026-09-17", to: "2026-09-23" });
  assert.deepEqual(resolveRecordPeriod({ period: "1m" }, NOW), { key: "1m", from: "2026-08-23", to: "2026-09-23" });
  assert.deepEqual(resolveRecordPeriod({ period: "3m" }, NOW), { key: "3m", from: "2026-06-23", to: "2026-09-23" });
  assert.deepEqual(resolveRecordPeriod({ period: "6m" }, NOW), { key: "6m", from: "2026-03-23", to: "2026-09-23" });
});

test("★ 그 달에 없는 날로 밀리지 않는다 — 3월 31일의 1개월 전은 2월 31일이 아니다", () => {
  const march31 = new Date("2026-03-31T03:00:00Z");
  assert.deepEqual(resolveRecordPeriod({ period: "1m" }, march31), { key: "1m", from: "2026-02-28", to: "2026-03-31" });
});

test("'전체' 와 모르는 키는 기간을 걸지 않는다", () => {
  assert.deepEqual(resolveRecordPeriod({}, NOW), { key: "all" });
  assert.deepEqual(resolveRecordPeriod({ period: "all" }, NOW), { key: "all" });
  assert.deepEqual(resolveRecordPeriod({ period: "없는키" }, NOW), { key: "all" });
});

test("연도는 그 해 전체 범위가 된다. 단 '전체' 를 고르면 연도를 덮어쓰지 않는다", () => {
  assert.deepEqual(resolveRecordPeriod({ year: 2024 }, NOW), { key: "year", from: "2024-01-01", to: "2024-12-31" });
  assert.deepEqual(resolveRecordPeriod({ period: "all", year: 2024 }, NOW), { key: "all" });
});

test("★ 직접 입력은 틀리면 틀렸다고 말한다 — 조용히 전체로 돌아가지 않는다", () => {
  // 조용히 넘어가면 "거른 줄 알았는데 안 걸러진 목록" 이 뜬다. 그게 가장 나쁜 실패다.
  assert.equal(resolveRecordPeriod({ period: "custom", from: "2026-09-01" }, NOW).error, "시작일과 종료일을 YYYY-MM-DD 형식으로 입력해 주세요.");
  assert.equal(resolveRecordPeriod({ period: "custom", from: "2026-13-01", to: "2026-09-19" }, NOW).error, "시작일과 종료일을 YYYY-MM-DD 형식으로 입력해 주세요.");
  assert.equal(resolveRecordPeriod({ from: "2026-09-19", to: "2026-09-01" }, NOW).error, "종료일은 시작일보다 빠를 수 없습니다.");
  assert.deepEqual(resolveRecordPeriod({ from: "2026-09-01", to: "2026-09-19" }, NOW), { key: "custom", from: "2026-09-01", to: "2026-09-19" });
});

test("★ 포함 판정은 UTC 가 아니라 KST 달력 날짜로 한다", () => {
  const period = { key: "custom", from: "2026-09-20", to: "2026-09-20" };
  // 2026-09-19 15:30 UTC = 2026-09-20 00:30 KST. UTC 로 자르면 이 경기가 빠진다.
  assert.equal(withinRecordPeriod("2026-09-19T15:30:00Z", period), true);
  assert.equal(withinRecordPeriod("2026-09-19T14:30:00Z", period), false, "23:30 KST 는 전날이다");
  assert.equal(withinRecordPeriod("2026-09-20T14:59:00Z", period), true, "23:59 KST 는 아직 그날이다");
  assert.equal(withinRecordPeriod("2026-09-20T15:00:00Z", period), false);
});

test("기간이 틀리면 아무것도 포함하지 않는다", () => {
  const broken = resolveRecordPeriod({ period: "custom", from: "2026-13-01", to: "2026-09-19" }, NOW);
  assert.equal(withinRecordPeriod("2026-09-19T00:00:00Z", broken), false);
  assert.equal(withinRecordPeriod(new Date(), broken), false);
});

test("기간 문구는 한 곳에서 만든다", () => {
  assert.equal(recordPeriodLabel(resolveRecordPeriod({}, NOW)), "모든 기간");
  assert.equal(recordPeriodLabel(resolveRecordPeriod({ period: "3m" }, NOW)), "최근 3개월");
  assert.equal(recordPeriodLabel(resolveRecordPeriod({ period: "custom", from: "2026-01-01", to: "2026-02-01" }, NOW)), "2026-01-01 – 2026-02-01");
  assert.equal(recordPeriodLabel(resolveRecordPeriod({ period: "custom", from: "2026-13-01", to: "2026-09-19" }, NOW)), "기간 확인 필요");
});

test("★ 연도 필터는 날짜 범위가 아니라 '2026년' 으로 읽힌다", () => {
  // 실제로 겪은 것: 연도를 고르면 머리글이 `2026-01-01 – 2026-12-31` 로 늘어났다.
  // resolveRecordPeriod 가 연도를 범위로 바꾸는데 문구 만드는 쪽이 그 key 를 몰랐다.
  assert.equal(recordPeriodLabel(resolveRecordPeriod({ year: 2026 }, NOW)), "2026년");
});
