import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyPricePath, quotedPrices, mergeSquadHistory } from "./price-history.ts";

test("quotes begin at the first actual price, preserving genuine low prices", () => {
  const points = [{ day: "2026-09-01", value: 0 }, { day: "2026-09-02", value: 0 },
    { day: "2026-09-03", value: 1 }, { day: "2026-09-04", value: 90000000 }];
  assert.deepEqual(quotedPrices(points), points.slice(2));
  assert.equal(points.length, 4, "raw data is unchanged");
  assert.deepEqual(quotedPrices([{ value: 0 }, { value: NaN }, { value: -1 }]), []);
});

test("missing and zero quote days leave gaps, not flat lines or artificial price drops", () => {
  const points = quotedPrices([
    { day: "2026-09-01", value: 10 }, { day: "2026-09-02", value: 20 },
    { day: "2026-09-03", value: 0 }, { day: "2026-09-04", value: 30 },
    { day: "2026-09-06", value: 40 },
  ]).map(p => ({ ...p, y: p.value }));
  assert.equal(dailyPricePath(points, d => Number(d.slice(-2)), n => n), "M1.0,10.0L2.0,20.0M4.0,30.0M6.0,40.0");
});

test("different release histories retain their own first date on a shared axis", () => {
  const old = [{ day: "2026-09-01", y: 10 }, { day: "2026-09-02", y: 11 }];
  const recent = [{ day: "2026-09-02", y: 20 }];
  const x = (d: string) => Number(d.slice(-2));
  assert.equal(dailyPricePath(old, x, n => n), "M1.0,10.0L2.0,11.0");
  assert.equal(dailyPricePath(recent, x, n => n), "M2.0,20.0");
});


test("collected valuations override estimates only on observed dates; missing observations remain dashed", () => {
  const estimated = [1, 2, 3].map(n => ({ day: `2026-10-0${n}`, value: 10 }));
  const collected = [{ day: "2026-10-01", value: 20 }, { day: "2026-10-03", value: 30 }];
  assert.deepEqual(mergeSquadHistory(estimated, collected).map(p => p.value), [20, 10, 30]);
  assert.equal(dailyPricePath(collected.map(p => ({ ...p, y: p.value })), d => Number(d.slice(-2)), n => n), "M1.0,20.0M3.0,30.0");
});
