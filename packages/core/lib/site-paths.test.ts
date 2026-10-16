import assert from "node:assert/strict";
import { test } from "node:test";

import { fcMatchHref, gameHomeHref, lobbyHref, navigationSite, profileHref, profilePrefix, routeHref, streamersHref } from "./site-paths.ts";

test("공유 화면: 게임 필터를 바꾸거나 지워도 들어온 게임의 메뉴를 유지한다", () => {
  assert.equal(navigationSite({ site: "fconline", game: "fconline" }), "fconline");
  assert.equal(navigationSite({ site: "fconline", game: "lol" }), "fconline");
  assert.equal(navigationSite({ site: "fconline" }), "fconline");
  assert.equal(navigationSite({ site: "lol", game: "fconline" }), "lol");
  assert.equal(navigationSite({ site: "platform", game: "fconline" }), "platform");
});

test("공유 화면: 기존 game 링크는 호환하고 잘못된 문맥은 채택하지 않는다", () => {
  assert.equal(navigationSite({ game: "fconline" }), "fconline");
  assert.equal(navigationSite({ game: "lol" }), "lol");
  assert.equal(navigationSite({ game: "etc" }), "platform");
  assert.equal(navigationSite({ site: "invalid", game: "fconline" }), "fconline");
  assert.equal(navigationSite({ site: ["fconline", "lol"], game: ["fconline", "lol"] }), "platform");
  assert.equal(navigationSite({}), "platform");
});

test("게임 홈·프로필·목록 주소", () => {
  assert.equal(lobbyHref(), "/");
  assert.equal(gameHomeHref("lol"), "/lol");
  assert.equal(gameHomeHref("fconline"), "/fc");
  assert.equal(profileHref("lol", "kim"), "/lol/s/kim");
  assert.equal(profileHref("fconline", "kim"), "/fc/s/kim");
  assert.ok(profileHref("lol", "kim").startsWith(profilePrefix("lol")));
  assert.equal(streamersHref(), "/lol/streamers");
  assert.equal(fcMatchHref("a/b"), "/fc/m/a%2Fb");
});

test("쿼리 — 빈 값은 빼고, URLSearchParams 도 받는다", () => {
  assert.equal(profileHref("lol", "kim", { tab: "events", year: 2026, opponent: undefined, q: "" }), "/lol/s/kim?tab=events&year=2026");
  assert.equal(profileHref("lol", "kim", {}), "/lol/s/kim");
  assert.equal(streamersHref(new URLSearchParams({ q: "이상호" })), "/lol/streamers?q=%EC%9D%B4%EC%83%81%ED%98%B8");
  assert.equal(streamersHref(new URLSearchParams()), "/lol/streamers");
});

test("slug 는 인코딩한다 — 한글·공백이 주소를 깨지 않게", () => {
  assert.equal(profileHref("lol", "김 민교"), "/lol/s/%EA%B9%80%20%EB%AF%BC%EA%B5%90");
});

test("routeHref — 파라미터 칸이 딱 맞는 경로를 고른다", () => {
  const routes = [{ path: "/tournaments" }, { path: "/tournaments/[slug]" }];
  assert.equal(routeHref(routes), "/tournaments");
  assert.equal(routeHref(routes, {}, { year: 2026 }), "/tournaments?year=2026");
  assert.equal(routeHref(routes, { slug: "a b" }, { tab: "teams" }), "/tournaments/a%20b?tab=teams");
  assert.equal(routeHref(routes, { id: "x" }), null);
  assert.equal(routeHref([]), null);
});

test('프로필 편성표는 메뉴만 유지하고 두 게임 일정을 모두 연다', async () => {
  const {profileScheduleQuery,profileGameFor} = await import('./site-paths.ts');
  assert.deepEqual(profileScheduleQuery('fconline','alpha'),{site:'fconline',s:'alpha'});
  assert.deepEqual(profileScheduleQuery('lol','alpha'),{site:'lol',s:'alpha'});
  assert.equal(profileGameFor(['lol','fconline'],'lol','fconline'),'lol');
  assert.equal(profileGameFor(['lol','fconline'],null,'fconline'),'fconline');
  assert.equal(profileGameFor(['fconline'],null,'platform'),'fconline');
  assert.equal(profileGameFor(['lol'],'fconline','fconline'),'lol');
});
