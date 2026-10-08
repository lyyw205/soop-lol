import { test } from "node:test";
import assert from "node:assert/strict";

import { autolinkParts } from "./autolink.ts";

const links = (text: string) => autolinkParts(text).filter((p) => p.kind === "link").map((p) => (p as { href: string }).href);

test("http(s) 주소만 링크가 된다", () => {
  assert.deepEqual(links("보세요 https://vod.sooplive.co.kr/player/123 그리고 http://a.example/x"),
    ["https://vod.sooplive.co.kr/player/123", "http://a.example/x"]);
});

test("★ HTML·스크립트는 글자로 남는다(해석하지 않는다)", () => {
  const parts = autolinkParts('<script>alert(1)</script> <img src=x onerror="alert(1)">');
  assert.deepEqual(parts, [{ kind: "text", value: '<script>alert(1)</script> <img src=x onerror="alert(1)">' }]);
});

test("★ javascript:·data: 같은 스킴은 링크가 안 된다", () => {
  assert.deepEqual(links("javascript:alert(1) data:text/html,<b>x</b>"), []);
});

test("주소 끝의 문장 부호는 링크에서 뗀다", () => {
  const parts = autolinkParts("여기(https://a.example/p?q=1).");
  assert.deepEqual(parts, [
    { kind: "text", value: "여기(" },
    { kind: "link", value: "https://a.example/p?q=1", href: "https://a.example/p?q=1" },
    { kind: "text", value: ")." },
  ]);
});

test("주소가 없으면 글자 하나로", () => {
  assert.deepEqual(autolinkParts("줄바꿈\n그대로"), [{ kind: "text", value: "줄바꿈\n그대로" }]);
  assert.deepEqual(links("https://"), []);
});
