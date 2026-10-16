import { test } from "node:test";
import assert from "node:assert/strict";
import { readRecordScope, writeRecordScope } from "./record-scope.ts";
test("필터 변경과 탭 이동은 사람·메뉴를 보존하고 연도를 하나의 기간으로 복원한다", () => {
  const query = new URLSearchParams("a=one&b=two&tab=players&site=fconline&year=2026&mode=50");
  const scope = readRecordScope(query);
  assert.deepEqual(scope.period, { key: "year", from: "2026-01-01", to: "2026-12-31" });
  const next = writeRecordScope(query, { ...scope, sort: "oldest" });
  assert.deepEqual(readRecordScope(next), { ...scope, sort: "oldest" });
  for (const key of ["a", "b", "tab", "site"]) assert.equal(next.get(key), query.get(key));
  const all = writeRecordScope(next, { ...scope, period: { key: "all" } });
  assert.equal(all.has("year"), false);
});
