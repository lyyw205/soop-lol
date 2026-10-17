import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, shownIn, stateOf, type Facts } from "./submission-policy.ts";

const f = (over: Partial<Facts>): Facts => ({ kind: "match_correction", intake: {}, admin: null, ...over });
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
