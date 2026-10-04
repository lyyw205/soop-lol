import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backcastSeries, changeOver, currentValue, decomposeChange, formatWon, holdingsSeries, shiftDay, unionHoldings,
  type HoldingRow, type PriceAt,
} from "./club-value.ts";

const row = (teamType: 0 | 1, slot: 1 | 2 | 3, spid: number, grade: number | null, price: number | null, isStarter = true): HoldingRow =>
  ({ teamType, slot, role: isStarter ? "st" : "ST", spid, grade, price, isStarter, name: `카드${spid}`, season: null, ovr: null });

test("합집합: 같은 카드+같은 강화는 한 장, 강화가 다르면 두 장, 칸과 선발 칸을 모은다", () => {
  const cards = unionHoldings([
    row(1, 1, 100, 11, 500), row(1, 3, 100, 11, 500, false), row(0, 1, 100, 11, 500),
    row(1, 2, 100, 8, 50),      // 같은 카드 다른 강화 = 실제로 두 장
    row(1, 1, 200, null, 7), row(0, 2, 200, null, 7),  // 강화를 모르면 spid 로 묶는다
  ]);
  assert.equal(cards.length, 3);
  const top = cards[0];
  assert.deepEqual([top.spid, top.grade, top.squads, top.starterIn], [100, 11, ["대표A", "대표C", "클럽A"], ["대표A", "클럽A"]]);
  assert.deepEqual(cards.map((c) => c.price), [500, 50, 7], "현재가 높은 순");
  assert.deepEqual(currentValue(cards), { value: 557, unpriced: 0 });
  assert.deepEqual(currentValue([{ price: null }, { price: 3 }]), { value: 3, unpriced: 1 });
});

const table: Record<string, Record<string, number>> = {
  "1:1": { "2026-09-01": 10, "2026-09-02": 12, "2026-09-03": 15 },
  "2:1": { "2026-09-02": 100, "2026-09-03": 90 },     // 9/2 에 나온 카드
  "3:1": { "2026-09-01": 1, "2026-09-02": 1, "2026-09-03": 1 },
};
const priceAt: PriceAt = (c, day) => table[`${c.spid}:${c.grade}`]?.[day];
const days = ["2026-09-01", "2026-09-02", "2026-09-03"];

test("소급 추정: 시세 이력이 있는 카드가 전부 값을 가진 날부터만, 강화 모르는 카드는 빼고 센다", () => {
  const s = backcastSeries([{ spid: 1, grade: 1 }, { spid: 2, grade: 1 }, { spid: 9, grade: null }], days, priceAt);
  assert.deepEqual(s.map((p) => [p.day, p.value, p.missing]), [["2026-09-02", 112, 1], ["2026-09-03", 105, 1]],
    "9/1 은 아직 없던 카드가 빠져 값이 가짜로 낮아지므로 내지 않는다");
  assert.deepEqual(backcastSeries([{ spid: 9, grade: null }], days, priceAt), []);
});

test("실제 이력: 그날 들고 있던 카드를 그날 시세로, 시세 없는 카드는 missing", () => {
  const s = holdingsSeries([
    { day: "2026-09-01", cards: [{ spid: 1, grade: 1 }, { spid: 2, grade: 1 }] },
    { day: "2026-09-03", cards: [{ spid: 1, grade: 1 }, { spid: 3, grade: 1 }] },
  ], priceAt);
  assert.deepEqual(s.map((p) => [p.value, p.priced, p.missing]), [[10, 1, 1], [16, 2, 0]]);
});

test("변동 분해: 시세 효과 + 교체 효과 = 전체 변화", () => {
  const prev = { day: "2026-09-02", cards: [{ spid: 1, grade: 1 }, { spid: 2, grade: 1 }] };
  const cur = { day: "2026-09-03", cards: [{ spid: 1, grade: 1 }, { spid: 3, grade: 1 }] };
  const c = decomposeChange(prev, cur, priceAt);
  assert.deepEqual({ market: c.market, trades: c.trades, added: c.added, removed: c.removed, missing: c.missing },
    { market: 3, trades: 1 - 100, added: 1, removed: 1, missing: 0 });
  const total = holdingsSeries([cur], priceAt)[0].value - holdingsSeries([prev], priceAt)[0].value;
  assert.equal(c.market + c.trades, total);
});

test("등락: 기준일 이하 가장 최근 값과, 기록이 모자라면 null", () => {
  const s = [{ day: "2026-09-01", value: 100 }, { day: "2026-09-05", value: 110 }, { day: "2026-09-08", value: 99 }];
  assert.deepEqual(changeOver(s, 7), { delta: -1, pct: -1, since: "2026-09-01" });
  assert.deepEqual(changeOver(s, 1)?.since, "2026-09-05");
  assert.equal(changeOver(s, 30), null, "30일 전 기록이 없으면 0% 가 아니라 모름");
  assert.equal(changeOver(s.slice(0, 1), 1), null);
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});

test("금액 표기", () => {
  assert.equal(formatWon(227_458_793_300), "2,274억 5,879만");
  assert.equal(formatWon(100_000_000), "1억");
  assert.equal(formatWon(12_600), "1만 2,600");
  assert.equal(formatWon(1_110), "1,110");
  assert.equal(formatWon(-4_840_000_000), "-48억 4,000만");
});
