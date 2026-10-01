import assert from "node:assert/strict";
import { test } from "node:test";

import { fcMatchHref, gameHomeHref, profileHref, profilePrefix, routeHref, streamersHref } from "./site-paths.ts";

test("게임 홈·프로필·목록 주소", () => {
  assert.equal(gameHomeHref("lol"), "/");
  assert.equal(gameHomeHref("fconline"), "/fc");
  assert.equal(profileHref("lol", "kim"), "/s/kim");
  assert.equal(profileHref("fconline", "kim"), "/fc/s/kim");
  assert.ok(profileHref("lol", "kim").startsWith(profilePrefix("lol")));
  assert.equal(streamersHref(), "/streamers");
  assert.equal(fcMatchHref("a/b"), "/fc/m/a%2Fb");
});

test("쿼리 — 빈 값은 빼고, URLSearchParams 도 받는다", () => {
  assert.equal(profileHref("lol", "kim", { tab: "events", year: 2026, opponent: undefined, q: "" }), "/s/kim?tab=events&year=2026");
  assert.equal(profileHref("lol", "kim", {}), "/s/kim");
  assert.equal(streamersHref(new URLSearchParams({ q: "이상호" })), "/streamers?q=%EC%9D%B4%EC%83%81%ED%98%B8");
  assert.equal(streamersHref(new URLSearchParams()), "/streamers");
});

test("slug 는 인코딩한다 — 한글·공백이 주소를 깨지 않게", () => {
  assert.equal(profileHref("lol", "김 민교"), "/s/%EA%B9%80%20%EB%AF%BC%EA%B5%90");
});

test("routeHref — 파라미터 칸이 딱 맞는 경로를 고른다", () => {
  const routes = [{ path: "/tournaments" }, { path: "/tournaments/[slug]" }];
  assert.equal(routeHref(routes), "/tournaments");
  assert.equal(routeHref(routes, {}, { year: 2026 }), "/tournaments?year=2026");
  assert.equal(routeHref(routes, { slug: "a b" }, { tab: "teams" }), "/tournaments/a%20b?tab=teams");
  assert.equal(routeHref(routes, { id: "x" }), null);
  assert.equal(routeHref([]), null);
});
