import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseValueRanking } from "./value-ranking.ts";
const html = readFileSync(new URL('./fixtures/value-ranking.html', import.meta.url), 'utf8');
test('extracts the full value ranking, not wins or ELO; keeps source date', () => {
  const r = parseValueRanking(html);
  assert.equal(r.day, '2026-10-01'); assert.equal(r.entries.length, 50);
  assert.deepEqual(r.entries.find(e => e.sn === 1809854163), { sn: 1809854163, nickname: '호날두', rank: 3, value: 461265317000 });
});
test('rejects partial, duplicated, wrong-section and undated responses', () => {
  for (const broken of [html.replace('50위', '49위'), html.replace('id="rankValue"', 'id="wrong"'), html.replace('id="strDate"', 'id="wrong"'), html.slice(0, html.indexOf('50위')), 'maintenance']) {
    assert.throws(() => parseValueRanking(broken));
  }
});
