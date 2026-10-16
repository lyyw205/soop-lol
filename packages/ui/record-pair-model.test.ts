import { test } from "node:test";
import assert from "node:assert/strict";
import { recordParts, recordText } from "./record-pair-model.ts";

const c = (win: number, draw: number, loss: number, unknown: number) => ({ win, draw, loss, unknown });

test("★ 승+무+패+미상 = 판 수 — 미상이 있으면 보인다", () => {
  assert.equal(recordText(c(12, 1, 10, 2)), "12승 1무 10패 · 미상 2");
  const parts = recordParts(c(3, 0, 1, 4));
  assert.equal(parts.reduce((n, p) => n + p.n, 0), 8);
  assert.equal(recordText(c(3, 0, 1, 4)), "3승 1패 · 미상 4");
});

test("무·미상이 0 이면 생략하고 승·패는 0 이어도 적는다", () => {
  assert.equal(recordText(c(0, 0, 0, 0)), "0승 0패");
  assert.equal(recordText(c(2, 0, 0, 0)), "2승 0패");
});
