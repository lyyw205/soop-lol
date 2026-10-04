import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSeasonGrades } from "./grades.ts";
const html = readFileSync(new URL("./fixtures/season-grades.html", import.meta.url), "utf8");
test("previous peak is distinct from previous final and all-time best; current is not current peak", () => {
  const grade = parseSeasonGrades(html);
  assert.equal(grade.current?.name, "챌린저 3부");
  assert.equal(grade.previousBest?.name, "슈퍼 챔피언스");
  assert.equal(grade.previousBest?.order, 21);
});
test("missing sections or unrecognized icons fail without substituting a grade", () => {
  assert.throws(() => parseSeasonGrades("maintenance"));
  assert.throws(() => parseSeasonGrades(html.replaceAll("ico_rank0.png", "ico_rank999.png")));
  assert.throws(() => parseSeasonGrades(html.replaceAll("ssl.nexon.com", "example.com")));
});
