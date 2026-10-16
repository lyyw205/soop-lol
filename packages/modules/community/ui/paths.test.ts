import assert from "node:assert/strict";
import { test } from "node:test";
import { navigationSite } from "@soop-lol/core/lib/contract/community-client";
import { communityHref, communityPostHref, communityQuery, communityReturnQuery } from "./paths.ts";

test("커뮤니티: 상세·수정 뒤 목록으로 돌아갈 때 메뉴와 필터·페이지 유지", () => {
  const query = communityQuery({ site: "fconline", game: "fconline", topic: "free", s: "kim", cursor: "next-page", edit: "1", write: "1" });
  const detail = new URL(communityPostHref(12, { ...query, edit: 1 }), "https://example.test");
  const back = new URL(communityHref(communityQuery(Object.fromEntries(detail.searchParams))), detail);
  assert.equal(navigationSite(Object.fromEntries(back.searchParams)), "fconline");
  assert.equal(back.searchParams.get("game"), "fconline");
  assert.equal(back.searchParams.has("topic"), false);
  assert.equal(back.searchParams.get("s"), "kim");
  assert.equal(back.searchParams.get("cursor"), "next-page");
  assert.equal(back.searchParams.has("edit"), false);
  assert.equal(back.searchParams.has("write"), false);
});

test("커뮤니티: 전체 필터와 글 저장/삭제 이후에도 FC 메뉴를 유지한다", () => {
  const query = communityQuery({ site: "fconline", topic: "free" });
  const form = new FormData();
  for (const [key, value] of Object.entries(query)) if (value) form.set(`return_${key}`, value);
  form.set("game", "lol"); // 글의 게임을 바꿔도 들어온 메뉴는 그대로다.
  form.set("return_url", "https://example.test/outside");
  const returned = communityReturnQuery(form);
  assert.deepEqual(returned, query);
  for (const href of [communityHref(returned), communityPostHref(12, returned)]) {
    const url = new URL(href, "https://example.test");
    assert.equal(navigationSite(Object.fromEntries(url.searchParams)), "fconline");
    assert.equal(url.searchParams.has("game"), false);
    assert.equal(url.searchParams.has("return_url"), false);
  }
});

test("커뮤니티: 이전 말머리 주소와 반환 값은 필터로 전달하지 않는다", () => {
  const form = new FormData();
  form.set("return_topic", "question");
  form.set("return_game", "lol");
  assert.equal(new URL(communityHref(communityReturnQuery(form)), "https://example.test").searchParams.has("topic"), false);
  assert.equal(communityReturnQuery(form).game, "lol");
});
