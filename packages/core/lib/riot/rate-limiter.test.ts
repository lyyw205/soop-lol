import { test } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter, parseLimitSpec } from "./rate-limiter.ts";

test("parseLimitSpec", () => {
  assert.deepEqual(parseLimitSpec("20:1,100:120"), [
    { limit: 20, windowSec: 1 },
    { limit: 100, windowSec: 120 },
  ]);
  assert.deepEqual(parseLimitSpec(""), []);
  assert.deepEqual(parseLimitSpec("garbage"), []);
});

test("리밋 안에서는 기다리지 않는다", async () => {
  const limiter = new RateLimiter({ initialAppLimits: "5:1" });
  const started = Date.now();
  for (let i = 0; i < 5; i++) await limiter.acquire("m");
  assert.ok(Date.now() - started < 100, "여유가 있는데 기다렸다");
});

test("리밋을 넘으면 창이 열릴 때까지 기다린다", async () => {
  // 0.2초 창에 2회. 3번째는 대기해야 한다.
  const limiter = new RateLimiter({ initialAppLimits: "2:0.2" });
  await limiter.acquire("m");
  await limiter.acquire("m");
  const started = Date.now();
  await limiter.acquire("m");
  assert.ok(Date.now() - started >= 150, "리밋을 넘겼는데 그냥 통과했다");
});

test("observe — 헤더가 오면 리밋 스펙이 넓어진다", async () => {
  const limiter = new RateLimiter({ initialAppLimits: "1:5" });
  limiter.observe("m", new Headers({ "x-app-rate-limit": "100:1" }));
  const started = Date.now();
  for (let i = 0; i < 10; i++) await limiter.acquire("m");
  assert.ok(Date.now() - started < 200, "헤더로 넓어진 리밋이 반영되지 않았다");
});

test("penalize — Retry-After 를 그대로 존중한다", () => {
  const limiter = new RateLimiter();
  const waitMs = limiter.penalize("m", new Headers({ "retry-after": "3", "x-rate-limit-type": "application" }));
  assert.ok(waitMs >= 3000 && waitMs < 3500, `Retry-After 를 무시했다: ${waitMs}`);
});

test("penalize — method 스코프는 그 메서드만 막는다", async () => {
  const limiter = new RateLimiter({ initialAppLimits: "100:1" });
  limiter.penalize("slow", new Headers({ "retry-after": "5", "x-rate-limit-type": "method" }));
  const started = Date.now();
  await limiter.acquire("fast"); // 다른 메서드는 영향받지 않아야 한다
  assert.ok(Date.now() - started < 100, "메서드 스코프 429 가 전체를 막았다");
});

test("observe — 서버가 보고한 카운트가 더 크면 보수적으로 맞춘다", async () => {
  const limiter = new RateLimiter({ initialAppLimits: "2:0.2" });
  // 우리는 0회라고 알고 있지만 서버는 2회 썼다고 한다 (재시작 직후 등)
  limiter.observe("m", new Headers({ "x-app-rate-limit": "2:0.2", "x-app-rate-limit-count": "2:0.2" }));
  const started = Date.now();
  await limiter.acquire("m");
  assert.ok(Date.now() - started >= 150, "서버 카운트를 무시하고 바로 나갔다");
});
