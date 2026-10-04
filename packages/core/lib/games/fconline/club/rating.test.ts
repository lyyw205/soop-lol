import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRating } from "./rating.ts";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
test("official 1v1 ELO preserves decimals and source time", () => {
  assert.deepEqual(parseRating(fixture("rank-france"), "호날두", 1809854163), { score: 2527.91, sourceAt: "2026-10-02T13:00:00+09:00" });
});
test("no ranking is null, not zero; malformed or mismatched identities fail", () => {
  assert.equal(parseRating(fixture("rank-empty"), "호날두", 1809854163).score, null);
  assert.throws(() => parseRating(fixture("rank-france"), "호날두", 1));
  assert.throws(() => parseRating(fixture("rank-france"), "다른사람", 1809854163));
  assert.throws(() => parseRating("maintenance", "호날두", 1809854163));
  assert.throws(() => parseRating(fixture("rank-france").replace("2527.91", "-"), "호날두", 1809854163));
});
