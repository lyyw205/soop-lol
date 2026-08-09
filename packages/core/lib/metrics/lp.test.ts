import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  APEX_BASE,
  DIVISION_OFFSET,
  TIER_BASE,
  formatRank,
  lpAbsolute,
  lpAbsoluteToRank,
  tierGridLines,
} from "./lp.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "db", "migrations");

/**
 * 마이그레이션 전체에서 `lol_lp_absolute` 를 **마지막으로 정의한** SQL 을 찾는다.
 * 파일 하나를 하드코딩하면 나중에 함수를 고치는 마이그레이션이 생겼을 때
 * 이 테스트가 옛 정의를 보며 계속 통과해 버린다 — 그게 제일 나쁜 실패다.
 */
function currentLpFunctionSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  let found = "";
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // ★ 정의문만 잡는다. `ALTER FUNCTION lol_lp_absolute ... SET search_path` 도
    //   "FUNCTION lol_lp_absolute" 를 포함해서, 그걸 집으면 본문이 없는 조각을 보게 된다.
    const at = sql.search(/CREATE (?:OR REPLACE )?FUNCTION lol_lp_absolute/);
    if (at >= 0) found = sql.slice(at, sql.indexOf("$$;", at));
  }
  return found;
}

/**
 * ★ 이 테스트가 존재하는 이유.
 *
 * 같은 상수표가 TS 와 SQL 두 군데에 있다. 경고 주석은 해결책이 아니다 —
 * 어긋나면 리더보드 정렬(SQL)과 차트 눈금(TS)이 조용히 따로 논다.
 * 그래서 마이그레이션 SQL 을 직접 읽어 대조한다. 한쪽만 고치면 여기서 깨진다.
 */
test("lp_absolute 상수표가 db/migrations 와 일치한다", () => {
  const fn = currentLpFunctionSql();
  assert.ok(fn.length > 0, "db/migrations 에서 lol_lp_absolute 함수를 못 찾았다");

  const fromSql = new Map<string, number>();
  for (const m of fn.matchAll(/WHEN\s+'([A-Z]+)'\s+THEN\s+(\d+)/g)) {
    fromSql.set(m[1], Number(m[2]));
  }

  for (const [tier, base] of Object.entries(TIER_BASE)) {
    assert.equal(fromSql.get(tier), base, `${tier} 기준값이 SQL 과 다르다`);
  }
  for (const apex of ["MASTER", "GRANDMASTER", "CHALLENGER"]) {
    assert.equal(fromSql.get(apex), APEX_BASE, `${apex} 기준값이 SQL 과 다르다`);
  }
  for (const [division, offset] of Object.entries(DIVISION_OFFSET)) {
    assert.equal(fromSql.get(division), offset, `디비전 ${division} 오프셋이 SQL 과 다르다`);
  }
});

test("lpAbsolute — 티어 순서가 단조증가한다", () => {
  const ladder = [
    { tier: "IRON", division: "IV", leaguePoints: 0 },
    { tier: "IRON", division: "I", leaguePoints: 99 },
    { tier: "BRONZE", division: "IV", leaguePoints: 0 },
    { tier: "GOLD", division: "II", leaguePoints: 50 },
    { tier: "EMERALD", division: "IV", leaguePoints: 0 },
    { tier: "DIAMOND", division: "I", leaguePoints: 99 },
    { tier: "MASTER", division: "I", leaguePoints: 0 },
    { tier: "GRANDMASTER", division: "I", leaguePoints: 500 },
    { tier: "CHALLENGER", division: "I", leaguePoints: 1200 },
  ];
  const values = ladder.map((r) => lpAbsolute(r)!);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `${ladder[i].tier} 가 앞 단계보다 크지 않다`);
  }
});

test("lpAbsolute — 언랭은 null", () => {
  assert.equal(lpAbsolute({ tier: null, division: null, leaguePoints: null }), null);
  assert.equal(lpAbsolute({ tier: "UNRANKED" }), null);
});

test("lpAbsolute — MASTER 이상은 디비전을 무시하고 LP 사다리가 연속이다", () => {
  assert.equal(lpAbsolute({ tier: "MASTER", division: "I", leaguePoints: 0 }), 2800);
  assert.equal(lpAbsolute({ tier: "GRANDMASTER", division: "IV", leaguePoints: 0 }), 2800);
  assert.equal(lpAbsolute({ tier: "CHALLENGER", leaguePoints: 1500 }), 4300);
});

test("lpAbsoluteToRank — 역변환이 왕복한다", () => {
  const cases = [
    { tier: "IRON", division: "IV", leaguePoints: 0 },
    { tier: "SILVER", division: "II", leaguePoints: 37 },
    { tier: "DIAMOND", division: "I", leaguePoints: 99 },
  ] as const;
  for (const c of cases) {
    const back = lpAbsoluteToRank(lpAbsolute(c)!);
    assert.equal(back.tier, c.tier);
    assert.equal(back.division, c.division);
    assert.equal(back.lp, c.leaguePoints);
  }
});

test("lpAbsoluteToRank — MASTER 이상은 세분하지 않는다", () => {
  const back = lpAbsoluteToRank(2800 + 213);
  assert.equal(back.tier, "MASTER+");
  assert.equal(back.division, null);
  assert.equal(back.lp, 213);
});

test("formatRank", () => {
  assert.equal(formatRank({ tier: "DIAMOND", division: "I", leaguePoints: 42 }), "D1 42LP");
  assert.equal(formatRank({ tier: "MASTER", division: "I", leaguePoints: 213 }), "M 213LP");
  assert.equal(formatRank({ tier: null }), "언랭");
});

test("tierGridLines — 범위 안의 경계만 돌려준다", () => {
  const lines = tierGridLines(1200, 2800);
  const labels = lines.map((l) => l.label);
  assert.deepEqual(labels, ["G", "P", "E", "D", "M"]);
});
