import assert from "node:assert/strict";
import { test } from "node:test";
import { navigationSite } from "@soop-lol/core/lib/contract/schedule";
import { scheduleEntryHref, scheduleHref, scheduleQuery } from "./paths.ts";

test("편성표: 상세와 목록 왕복에서 게임 메뉴·콘텐츠 필터·날짜·스트리머 유지", () => {
  const query = scheduleQuery({ site: "fconline", game: "fconline", date: "2026-10-13", s: "kim", kind: "ck", q: "저녁" });
  const detail = new URL(scheduleEntryHref("sample-entry", query), "https://example.test");
  const back = new URL(scheduleHref(scheduleQuery(Object.fromEntries(detail.searchParams))), detail);
  assert.deepEqual(Object.fromEntries(back.searchParams), query);
  assert.equal(navigationSite(Object.fromEntries(back.searchParams)), "fconline");
});

test("편성표: 전체 필터의 새 탭·새로고침에서도 FC 메뉴 유지", () => {
  const query = scheduleQuery({ game: "fconline" });
  const all = new URL(scheduleHref({ ...query, game: undefined }), "https://example.test");
  assert.equal(all.searchParams.has("game"), false);
  assert.equal(navigationSite(Object.fromEntries(all.searchParams)), "fconline");
});
