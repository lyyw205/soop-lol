import { test } from "node:test";
import assert from "node:assert/strict";
import { readRecordScope, scopeFormat, writeRecordScope } from "./record-scope.ts";
test("필터 변경과 탭 이동은 사람·메뉴를 보존하고 연도를 하나의 기간으로 복원한다", () => {
  const query = new URLSearchParams("a=one&b=two&tab=players&site=fconline&year=2026&mode=50&format=ck&map=aram");
  const scope = readRecordScope(query);
  assert.deepEqual(scope.period, { key: "year", from: "2026-01-01", to: "2026-12-31" });
  assert.equal(scope.format, "ck");
  assert.equal(scope.map, "aram");
  const next = writeRecordScope(query, { ...scope, sort: "oldest" });
  assert.deepEqual(readRecordScope(next), { ...scope, sort: "oldest" });
  for (const key of ["a", "b", "tab", "site"]) assert.equal(next.get(key), query.get(key));
  const all = writeRecordScope(next, { ...scope, period: { key: "all" }, map: "rift", format: "all" });
  assert.equal(all.has("year"), false);
  assert.equal(all.has("map"), false, "기본 맵(협곡)은 주소에 적지 않는다");
  assert.equal(all.has("format"), false);
});
test("옛 분류 값·모르는 값은 기본값(협곡·전체)으로 간다", () => {
  const scope = readRecordScope(new URLSearchParams("category=solo&format=other&map=arena"));
  assert.equal(scope.map, "rift");
  assert.equal(scope.format, "all");
});
test("★ 칼바람은 진행 방식으로 나누지 않는다 — 칼바람 탭에서는 format 을 걸지 않는다", () => {
  assert.equal(scopeFormat("aram", "ck"), null);
  assert.equal(scopeFormat("rift", "ck"), "ck");
  assert.equal(scopeFormat("rift", "all"), null);
  assert.equal(scopeFormat("rift", "unclassified"), "unclassified", "분류 전도 하나의 칩이다");
});
