import { test } from "node:test";
import assert from "node:assert/strict";

import { activeSanction, rejoinBlockedUntil } from "./community.ts";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

test("재가입 제한 — 제재가 없으면 탈퇴 + 30일", () => {
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [])), "2026-10-31");
});

test("재가입 제한 — 기간 제재는 끝날 때까지, 30일보다 짧으면 30일", () => {
  const long = { created_at: d("2026-09-20"), ends_at: d("2026-12-01"), lifted_at: null };
  const short = { created_at: d("2026-09-28"), ends_at: d("2026-10-05"), lifted_at: null };
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [long])), "2026-12-01");
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [short])), "2026-10-31");
});

test("★ 재가입 제한 — 탈퇴 뒤에 걸린 영구 제재도 반영된다(제재 시각 + 1년)", () => {
  // 탈퇴 29일째 영구 제재 → 31일째에도 막혀 있어야 한다
  const late = { created_at: d("2026-10-30"), ends_at: null, lifted_at: null };
  const until = rejoinBlockedUntil(d("2026-10-01"), [late]);
  assert.equal(iso(until), "2027-10-30");
  assert.ok(until > d("2026-11-01"));
});

test("재가입 제한 — 풀린 제재는 세지 않는다(다시 30일 기준)", () => {
  const lifted = { created_at: d("2026-09-20"), ends_at: null, lifted_at: d("2026-10-02") };
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [lifted])), "2026-10-31");
});

test("지금 막는 제재 — 시작 전·끝난 뒤·풀린 것은 아니다", () => {
  const now = d("2026-10-10");
  const ended = { created_at: d("2026-10-01"), ends_at: d("2026-10-05"), lifted_at: null };
  const running = { created_at: d("2026-10-08"), ends_at: d("2026-10-15"), lifted_at: null };
  const permanent = { created_at: d("2026-10-01"), ends_at: null, lifted_at: null };
  const lifted = { created_at: d("2026-10-01"), ends_at: null, lifted_at: d("2026-10-09") };
  assert.equal(activeSanction([ended, lifted], now), null);
  assert.equal(activeSanction([ended, running], now), running);
  assert.equal(activeSanction([permanent], now), permanent);
});
