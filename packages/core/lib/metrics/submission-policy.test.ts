import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, POLICY, roleInEffect, shownIn, stateOf, type Facts, type Policy } from "./submission-policy.ts";

const f = (over: Partial<Facts>): Facts => ({
  kind: "match_correction", intake: {}, admin: null, reporter: { roles: [] }, agreement: { members: 1, trusted: 0 }, vod: { state: "none" }, ...over,
});
const on = (config: Partial<Policy["config"]>): Policy => ({ ...POLICY, config: { ...POLICY.config, ...config } });
const state = (x: Partial<Facts>, wasShown = false) => stateOf(decide(f(x)), wasShown);

test("기준 2026-10-18.1 — 경기 고치기는 운영자 확인 대기, 편성표는 바로 반영 + 확인 전(사용자 결정 10/18)", () => {
  assert.deepEqual(decide(f({})), { visibility: "hidden", trust: "pending", hold_reason: "correction_review", rule: "correction_review", effects: [] });
  assert.equal(state({}), "held");
  assert.deepEqual(decide(f({ kind: "schedule_report" })), { visibility: "shown", trust: "pending", hold_reason: null, rule: "schedule_apply", effects: [] });
  assert.equal(state({ kind: "schedule_report" }), "applied");
  // 같은 일정의 열린 제보가 있거나 방송 칸이 여럿인 일정의 날짜면 운영자 대기.
  assert.equal(decide(f({ kind: "schedule_report", intake: { contested: true } })).hold_reason, "contested");
  assert.equal(decide(f({ kind: "schedule_report", intake: { multi_slot: true } })).rule, "schedule_multi_slot");
  assert.equal(state({ kind: "schedule_report", admin: "reject" }, true), "reverted");
});

test("보류 사실은 정해진 순서로 하나의 이유가 된다(앞의 것이 먼저)", () => {
  assert.equal(decide(f({ intake: { contested: true, review_completed: true } })).hold_reason, "review_completed");
  assert.equal(decide(f({ intake: { not_public: true, api_observed: true } })).rule, "hold_not_public");
  assert.equal(decide(f({ intake: { contested: true } })).hold_reason, "contested");
  assert.equal(state({ intake: { account_identity: true } }), "held");
});

test("운영자의 결정은 어떤 사실보다 위다 — 확인은 보임·믿음, 반려는 보였으면 되돌림·아니면 반려", () => {
  assert.equal(state({ intake: { review_completed: true }, admin: "verify" }), "verified");
  assert.equal(state({ kind: "schedule_report", admin: "verify" }), "verified");
  assert.equal(state({ admin: "reject" }, true), "reverted");
  assert.equal(state({ admin: "reject" }, false), "rejected");
});

test("옛 상태 이름 ↔ 보임", () => {
  assert.deepEqual(["applied", "held", "verified", "reverted", "rejected", "duplicate"].map((s) => shownIn(s as never)), [true, false, true, false, false, false]);
});

test("신뢰 계정·합의는 지금 꺼 둔 채다(사용자 결정) — 역할이 있고 여럿이 같아도 운영자 확인 대기 그대로", () => {
  assert.deepEqual(POLICY.config, { trustedReporter: false, consensusMembers: null });
  assert.equal(decide(f({ reporter: { roles: ["trusted_reporter"] }, agreement: { members: 9, trusted: 9 } })).rule, "correction_review");
  assert.equal(roleInEffect("trusted_reporter"), false);
});

test("켜면 — 신뢰 제보자·N명 합의는 경기 고치기를 바로 검증한다", () => {
  const trusted = f({ reporter: { roles: ["trusted_reporter"] } });
  assert.deepEqual(decide(trusted, on({ trustedReporter: true })), { visibility: "shown", trust: "verified", hold_reason: null, rule: "trusted", effects: [] });
  assert.equal(stateOf(decide(trusted, on({ trustedReporter: true })), false), "verified");
  assert.equal(decide(f({ agreement: { members: 2, trusted: 0 } }), on({ consensusMembers: 3 })).rule, "correction_review");
  assert.equal(decide(f({ agreement: { members: 3, trusted: 0 } }), on({ consensusMembers: 3 })).rule, "consensus");
  assert.equal(roleInEffect("trusted_reporter", on({ trustedReporter: true })), true);
});

test("켜도 보류를 건너뛰지 않고, 편성표에는 쓰지 않는다 — 운영자 결정은 그 위", () => {
  const all = on({ trustedReporter: true, consensusMembers: 2 });
  const strong = { reporter: { roles: ["trusted_reporter"] as const }, agreement: { members: 5, trusted: 5 } };
  assert.equal(decide(f({ ...strong, intake: { api_observed: true } }), all).rule, "hold_api_observed");
  assert.equal(decide(f({ ...strong, kind: "schedule_report" }), all).rule, "schedule_apply");
  assert.equal(decide(f({ ...strong, admin: "reject" }), all).rule, "admin_reject");
});

test("VOD 단서 — 판독 전엔 숨김·대기 + 대기열 맨 앞(할 일), 찾으면 확인, 못 찾거나 영상이 없으면 운영자", () => {
  const hint = (state: Facts["vod"]["state"]) => decide(f({ kind: "vod_hint", vod: { state } }));
  for (const s of ["none", "queued"] as const) {
    assert.deepEqual(hint(s), { visibility: "hidden", trust: "pending", hold_reason: "vod_pending", rule: "hint_pending", effects: ["vod_priority"] });
  }
  assert.equal(stateOf(hint("found"), false), "verified");
  assert.equal(hint("found").rule, "hint_found");
  assert.deepEqual([hint("not_found").hold_reason, hint("unavailable").hold_reason], ["vod_not_found", "vod_unavailable"]);
  assert.deepEqual(hint("not_found").effects, []);
  assert.equal(decide(f({ kind: "vod_hint", vod: { state: "queued" }, admin: "reject" })).rule, "admin_reject");
  // 신뢰 계정·합의는 단서에 쓰지 않는다(켜도).
  assert.equal(decide(f({ kind: "vod_hint", reporter: { roles: ["trusted_reporter"] } }), on({ trustedReporter: true, consensusMembers: 1 })).rule, "hint_pending");
});

test("직접 입력 — 판독 전엔 보임·검증 전 + 대기열 맨 앞, 찾으면 판독 값으로 덮고 검증, 판독할 수 없으면 검증 전 그대로(운영자)", () => {
  const add = (state: Facts["vod"]["state"]) => decide(f({ kind: "match_addition", vod: { state } }));
  for (const s of ["none", "queued"] as const) {
    assert.deepEqual(add(s), { visibility: "shown", trust: "pending", hold_reason: null, rule: "addition_pending", effects: ["vod_priority"] });
  }
  assert.deepEqual(add("found"), { visibility: "shown", trust: "verified", hold_reason: null, rule: "addition_found", effects: ["adopt_vod"] });
  for (const s of ["not_found", "unavailable", "no_vod"] as const) {
    assert.deepEqual(add(s), { visibility: "shown", trust: "pending", hold_reason: null, rule: "addition_unverifiable", effects: [] });
  }
  assert.equal(stateOf(add("queued"), false), "applied");
  assert.equal(stateOf(decide(f({ kind: "match_addition", vod: { state: "queued" }, admin: "reject" })), true), "reverted");
});
