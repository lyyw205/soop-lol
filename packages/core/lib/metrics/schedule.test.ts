import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDays, buildSlotTimes, daysBetween, entryPeriod, entryState, kstDayStart, pickBroadcastChannel,
  slotPhase, slotTimeLabel, validateScheduleInput, type ScheduleInput, type SlotTime,
} from "./schedule.ts";

/** KST 벽시계 → 순간. */
const kst = (s: string) => new Date(`${s}:00+09:00`);
const slot = (on_date: string, start?: string, end?: string): SlotTime => ({
  on_date,
  starts_at: start ? kst(`${on_date}T${start}`) : null,
  ends_at: end ? kst(end.includes("T") ? end : `${on_date}T${end}`) : null,
});

test("날짜 — 달력에 없는 날짜는 null, 더하기·차이", () => {
  assert.equal(kstDayStart("2026-10-03")!.toISOString(), "2026-10-02T15:00:00.000Z");
  assert.equal(kstDayStart("2026-02-30"), null);
  assert.equal(kstDayStart("어제"), null);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(daysBetween("2026-10-01", "2026-10-14"), 13);
});

test("칸 — 시작·끝을 알 때: 전 / 공지상 진행 시간 / 지남", () => {
  const s = slot("2026-10-03", "20:00", "23:00");
  assert.equal(slotPhase(s, kst("2026-10-03T19:59")), "upcoming");
  assert.equal(slotPhase(s, kst("2026-10-03T20:00")), "in_window");
  assert.equal(slotPhase(s, kst("2026-10-03T23:00")), "past");
});

test("칸 — 종료 미정: 시작 후엔 'started', 그날이 끝나면 지남 (진행 시간이라 말하지 않는다)", () => {
  const s = slot("2026-10-03", "20:00");
  assert.equal(slotPhase(s, kst("2026-10-03T19:00")), "upcoming");
  assert.equal(slotPhase(s, kst("2026-10-03T23:59")), "started");
  assert.equal(slotPhase(s, kst("2026-10-04T00:00")), "past");
});

test("칸 — 시각 미정: 그날 안에서는 진행 판정을 하지 않는다", () => {
  const s = slot("2026-10-03");
  assert.equal(slotPhase(s, kst("2026-10-03T21:00")), "upcoming");
  assert.equal(slotPhase(s, kst("2026-10-04T00:00")), "past");
});

test("일정 상태 — 계획서 §1 표의 모든 칸", () => {
  const one = [slot("2026-10-03", "20:00", "23:00")];
  assert.equal(entryState("cancelled", one, kst("2026-10-03T21:00")), "cancelled");
  assert.equal(entryState("scheduled", one, kst("2026-10-03T19:00")), "upcoming");
  assert.equal(entryState("held", one, kst("2026-10-03T21:00")), "in_window");
  assert.equal(entryState("scheduled", one, kst("2026-10-04T00:00")), "past_unconfirmed");
  assert.equal(entryState("held", one, kst("2026-10-04T00:00")), "held");
});

test("일정 상태 — 여러 날 대회: 하루가 끝났어도 남은 날이 있으면 예정, 전부 지나야 지난 일정", () => {
  const days = [slot("2026-10-01", "18:00", "22:00"), slot("2026-10-05", "18:00", "22:00")];
  assert.equal(entryState("scheduled", days, kst("2026-10-03T12:00")), "upcoming");
  assert.equal(entryState("scheduled", days, kst("2026-10-05T19:00")), "in_window");
  assert.equal(entryState("scheduled", days, kst("2026-10-06T00:00")), "past_unconfirmed",
    "시간이 지났다고 개최 확인이 아니다 — 대형도 사람이 held 로 확인한다");
  assert.deepEqual(entryPeriod(days), { from: "2026-10-01", to: "2026-10-05" });
});

test("시각 문구", () => {
  assert.equal(slotTimeLabel(slot("2026-10-03")), "시각 미정");
  assert.equal(slotTimeLabel(slot("2026-10-03", "20:00")), "20:00 시작");
  assert.equal(slotTimeLabel(slot("2026-10-03", "20:00", "23:30")), "20:00–23:30");
});

test("입력 — 끝이 시작보다 이르면 다음 날, 없는 날짜·시각은 오류", () => {
  const night = buildSlotTimes("2026-10-03", "22:00", "01:00");
  assert.ok(night.ok);
  assert.equal(night.ok && night.ends_at!.toISOString(), "2026-10-03T16:00:00.000Z");
  assert.deepEqual(buildSlotTimes("2026-10-03", "", ""), { ok: true, starts_at: null, ends_at: null });
  assert.equal(buildSlotTimes("2026-02-30", "20:00", "").ok, false);
  assert.equal(buildSlotTimes("2026-10-03", "25:00", "").ok, false);
  assert.equal(buildSlotTimes("2026-10-03", "", "23:00").ok, false, "끝만 있으면 안 된다");
});

test("방송 채널 — 명시값 우선, 주최 한 명·채널 하나일 때만 자동", () => {
  assert.equal(pickBroadcastChannel("explicit", [{ channels: ["a"] }]), "explicit");
  assert.equal(pickBroadcastChannel(null, [{ channels: ["a"] }]), "a");
  assert.equal(pickBroadcastChannel(null, [{ channels: ["a", "b"] }]), null, "채널이 둘이면 모른다");
  assert.equal(pickBroadcastChannel(null, [{ channels: ["a"] }, { channels: ["b"] }]), null, "주최가 둘이면 모른다");
  assert.equal(pickBroadcastChannel(null, []), null);
});

const base = (): ScheduleInput => ({
  game_code: "lol", title: "추석 CK", scale: "minor", planned_kind: "ck", sponsor: null, description: null, admin_note: null,
  status: "scheduled", event_id: null, visibility: "public",
  slots: [{ label: null, channel_id: null, ...slot("2026-10-03", "20:00", "23:00") }],
  participants: [], sources: [{ url: "https://ch.sooplive.co.kr/x/post/1", title: null, posted_at: null }],
});

test("검증 — 통과하는 기본형", () => {
  assert.deepEqual(validateScheduleInput(base()), []);
});

test("검증 — 공개인데 출처가 없으면 거부, 숨김이면 허용", () => {
  assert.ok(validateScheduleInput({ ...base(), sources: [] }).some((e) => e.includes("출처")));
  assert.deepEqual(validateScheduleInput({ ...base(), sources: [], visibility: "hidden" }), []);
});

test("검증 — 칸 날짜와 시작 시각의 날짜가 다르면 거부", () => {
  const bad = { ...base(), slots: [{ label: null, channel_id: null, on_date: "2026-10-04", starts_at: kst("2026-10-03T20:00"), ends_at: null }] };
  assert.ok(validateScheduleInput(bad).some((e) => e.includes("날짜가 칸 날짜와")));
});

test("검증 — 결과 연결은 개최 확인일 때만, 칸이 없으면 거부", () => {
  assert.ok(validateScheduleInput({ ...base(), event_id: "00000000-0000-0000-0000-000000000000" }).some((e) => e.includes("개최 확인")));
  assert.ok(validateScheduleInput({ ...base(), slots: [] }).some((e) => e.includes("칸")));
});
