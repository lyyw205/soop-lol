import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, POLICY, roleInEffect, shownIn, stateOf, type Facts, type Policy } from "./submission-policy.ts";

const f = (over: Partial<Facts>): Facts => ({
  kind: "match_correction", intake: {}, admin: null, reporter: { roles: [] }, agreement: { members: 1, trusted: 0 }, ...over,
});
const on = (config: Partial<Policy["config"]>): Policy => ({ ...POLICY, config: { ...POLICY.config, ...config } });
const state = (x: Partial<Facts>, wasShown = false) => stateOf(decide(f(x)), wasShown);

test("v1 = 1단계·3단계 동작 그대로 — 경기 고치기는 바로 반영(확인 전), 편성표는 운영자 대기", () => {
  assert.deepEqual(decide(f({})), { visibility: "shown", trust: "pending", hold_reason: null, rule: "apply_pending" });
  assert.equal(state({}), "applied");
  assert.deepEqual(decide(f({ kind: "schedule_report" })), { visibility: "hidden", trust: "pending", hold_reason: "schedule_review", rule: "schedule_review" });
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

test("신뢰 계정·합의는 지금 꺼 둔 채다(사용자 결정) — 역할이 있고 여럿이 같아도 확인 전 그대로", () => {
  assert.deepEqual(POLICY.config, { trustedReporter: false, consensusMembers: null });
  assert.equal(decide(f({ reporter: { roles: ["trusted_reporter"] }, agreement: { members: 9, trusted: 9 } })).rule, "apply_pending");
  assert.equal(roleInEffect("trusted_reporter"), false);
});

test("켜면 — 신뢰 제보자·N명 합의는 경기 고치기를 바로 검증한다", () => {
  const trusted = f({ reporter: { roles: ["trusted_reporter"] } });
  assert.deepEqual(decide(trusted, on({ trustedReporter: true })), { visibility: "shown", trust: "verified", hold_reason: null, rule: "trusted" });
  assert.equal(stateOf(decide(trusted, on({ trustedReporter: true })), false), "verified");
  assert.equal(decide(f({ agreement: { members: 2, trusted: 0 } }), on({ consensusMembers: 3 })).rule, "apply_pending");
  assert.equal(decide(f({ agreement: { members: 3, trusted: 0 } }), on({ consensusMembers: 3 })).rule, "consensus");
  assert.equal(roleInEffect("trusted_reporter", on({ trustedReporter: true })), true);
});

test("켜도 보류를 건너뛰지 않고, 편성표에는 쓰지 않는다 — 운영자 결정은 그 위", () => {
  const all = on({ trustedReporter: true, consensusMembers: 2 });
  const strong = { reporter: { roles: ["trusted_reporter"] as const }, agreement: { members: 5, trusted: 5 } };
  assert.equal(decide(f({ ...strong, intake: { api_observed: true } }), all).rule, "hold_api_observed");
  assert.equal(decide(f({ ...strong, kind: "schedule_report" }), all).rule, "schedule_review");
  assert.equal(decide(f({ ...strong, admin: "reject" }), all).rule, "admin_reject");
});
