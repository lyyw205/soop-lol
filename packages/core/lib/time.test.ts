import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fromKstInputValue, kstDateString, kstYear, nextKstHour, toEpochSeconds, toKstInputValue,
} from "./time.ts";

test("kstDateString — UTC 자정 직전은 이미 KST 로 다음 날이다", () => {
  // 2026-08-09T15:30:00Z = 2026-08-10 00:30 KST
  assert.equal(kstDateString(new Date("2026-08-09T15:30:00Z")), "2026-08-10");
  assert.equal(kstDateString(new Date("2026-08-09T14:59:59Z")), "2026-08-09");
});

test("kstDateString — 09:00 KST 스냅샷은 그날 날짜로 찍힌다", () => {
  // 09:00 KST = 00:00 UTC 같은 날
  assert.equal(kstDateString(new Date("2026-08-09T00:00:00Z")), "2026-08-09");
});

test("kstYear — 연말 경계", () => {
  assert.equal(kstYear(new Date("2025-12-31T15:00:00Z")), 2026);
  assert.equal(kstYear(new Date("2025-12-31T14:59:59Z")), 2025);
});

test("nextKstHour — 아직 오늘 09시가 안 지났으면 오늘", () => {
  // 2026-08-09T00:00:00Z = 09:00 KST. 그 1분 전이면 오늘 09시.
  const at = new Date("2026-08-08T23:59:00Z");
  assert.equal(nextKstHour(at, 9).toISOString(), "2026-08-09T00:00:00.000Z");
});

test("nextKstHour — 정각이면 다음 날 (같은 실행에서 두 번 돌지 않는다)", () => {
  const at = new Date("2026-08-09T00:00:00Z");
  assert.equal(nextKstHour(at, 9).toISOString(), "2026-08-10T00:00:00.000Z");
});

test("nextKstHour — 지났으면 다음 날", () => {
  const at = new Date("2026-08-09T05:00:00Z"); // 14:00 KST
  assert.equal(nextKstHour(at, 9).toISOString(), "2026-08-10T00:00:00.000Z");
});

test("toEpochSeconds — ms 가 아니라 초다", () => {
  assert.equal(toEpochSeconds(new Date("2026-08-09T00:00:00Z")), 1786233600);
});

test("datetime-local 왕복 — 손 안 대고 저장해도 값이 안 밀린다", () => {
  // 2026-09-19T13:01:49Z = 2026-09-19 22:01:49 KST
  const at = new Date("2026-09-19T13:01:49.000Z");
  const shown = toKstInputValue(at);
  assert.equal(shown, "2026-09-19T22:01:49", "화면은 KST 벽시계를 보여준다");
  assert.equal(fromKstInputValue(shown)!.toISOString(), at.toISOString(), "그대로 돌아온다");
});

test("datetime-local — 초가 없어도 받는다 (step 없는 브라우저)", () => {
  assert.equal(fromKstInputValue("2026-09-19T22:01")!.toISOString(), "2026-09-19T13:01:00.000Z");
});

test("datetime-local — 형식이 아니면 null (던지지 않는다)", () => {
  assert.equal(fromKstInputValue("어제"), null);
  assert.equal(fromKstInputValue(""), null);
});

test("★ UTC 문자열을 그대로 넣던 옛 방식은 9시간 밀렸다 — 회귀 방지", () => {
  const at = new Date("2026-09-19T13:01:49.000Z");
  const oldWay = at.toISOString().slice(0, 16);           // 옛 코드
  assert.notEqual(toKstInputValue(at).slice(0, 16), oldWay);
  assert.equal(fromKstInputValue(oldWay)!.toISOString(), "2026-09-19T04:01:00.000Z");
});
