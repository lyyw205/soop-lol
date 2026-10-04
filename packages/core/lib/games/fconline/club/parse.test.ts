import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ClubParseError, gradeFromEachPrice, parsePriceGraph, parseProfile, parseSquad, parseTooltip, parseWon,
} from "./parse.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

test("구단주 검색: 프로필 화면에서 회원번호·캐릭터ID·감독명을 꺼낸다", () => {
  const r = parseProfile(fixture("profile-found.html"), "https://fconline.nexon.com/profile/squad/popup/1977710213");
  assert.deepEqual(r, { kind: "found", sn: 1977710213, characterId: "6b07d5bd64eeb9a0ffed86a1", nickname: "저창FC" });
});

test("구단주 검색: 없는 감독명은 missing, 알아볼 수 없는 화면은 실패", () => {
  assert.deepEqual(parseProfile(fixture("profile-missing.html"), "https://fconline.nexon.com/profile/common/PopProfile"),
    { kind: "missing" });
  assert.throws(() => parseProfile("<html>점검 중</html>", "https://fconline.nexon.com/"), ClubParseError);
  assert.throws(() => parseProfile(fixture("profile-found.html"), "https://fconline.nexon.com/profile/squad/popup/1"),
    ClubParseError, "주소와 화면의 회원번호가 다르면 믿지 않는다");
});

test("툴팁: 감독명과 공식 구단가치(원 단위 정확값)", () => {
  assert.deepEqual(parseTooltip(fixture("tooltip.html")), { nickname: "저창FC", clubValue: 212235711090 });
  assert.throws(() => parseTooltip("<div class=\"value\">?</div>"), ClubParseError);
});

test("스쿼드: 18자리, 선발 11, 강화는 강화별 현재가에서 구하고 넥슨 선발 합과 맞는다", () => {
  const squad = parseSquad(fixture("squad.json"));
  assert.equal(squad.players.length, 18);
  const starters = squad.players.filter((p) => p.isStarter);
  assert.equal(starters.length, 11);
  assert.equal(starters.reduce((sum, p) => sum + (p.price ?? 0), 0), squad.totalPrice);
  const mbappe = squad.players.find((p) => p.spid === 856231747);
  assert.equal(mbappe?.grade, 11);
  // 2026-09-29 경기 상세의 spGrade 와 대조한 값 — 쿤데 13강, 메냥 10강, 리코 0
  assert.equal(squad.players.find((p) => p.spid === 815241486)?.grade, 13);
  assert.equal(squad.players.find((p) => p.spid === 828215698)?.grade, 10);
  assert.equal(squad.players.find((p) => p.spid === 323206652)?.grade, 0);
  assert.ok(squad.players.filter((p) => !p.isStarter).every((p) => p.role === p.role.toUpperCase()));
});

test("스쿼드: 2군 칸도 같은 형식이고, 빈 응답은 캐릭터ID 불일치로 실패", () => {
  const second = parseSquad(fixture("squad-2nd.json"));
  assert.equal(second.players.filter((p) => p.isStarter).length, 11);
  assert.throws(() => parseSquad(""), /빈 응답/);
  assert.throws(() => parseSquad("{\"players\":[]}"), ClubParseError);
});

test("강화 추정은 값이 정확히 하나일 때만", () => {
  assert.equal(gradeFromEachPrice("1,570,000,000", "0|11,500|1,570,000,000|2,430,000,000"), 2);
  assert.equal(gradeFromEachPrice("100", "0|100|100|200"), null);
  assert.equal(gradeFromEachPrice("999", "0|100|200"), null);
});

test("시세 그래프: 현재가와 일별 값, 연도 없는 날짜를 조회일부터 거꾸로 붙인다", () => {
  const g = parsePriceGraph(fixture("price-graph.html"), "2026-10-02");
  assert.equal(g.current, 42_800_000_000);
  assert.equal(g.points.length, 99);
  assert.deepEqual(g.points[0].day, "2026-06-25");
  assert.deepEqual(g.points.at(-1), { day: "2026-10-01", price: 41_190_909_100 });
  assert.notEqual(g.points.at(-1)?.price, g.current, "일별 값과 현재가는 다른 숫자다");
});

test("시세 그래프: 365일짜리는 해를 넘겨 이어진다", () => {
  const g = parsePriceGraph(fixture("price-graph-year.html"), "2026-10-02");
  assert.equal(g.points.length, 365);
  assert.equal(g.points[0].day, "2025-10-02");
  assert.equal(g.points.at(-1)?.day, "2026-10-01");
  for (let i = 1; i < g.points.length; i++) assert.ok(g.points[i - 1].day < g.points[i].day);
});

test("시세 그래프: 2.29 는 윤년으로, 망가진 응답은 실패", () => {
  const html = (times: string[], values: string[]) =>
    `var json1 = { "time": [${times.map((t) => `"${t}"`).join(",")}], "value": [${values.map((v) => `"${v}"`).join(",")}] }`;
  const g = parsePriceGraph(html(["2.28", "2.29", "3.01"], ["1", "2", "3"]), "2028-03-05");
  assert.deepEqual(g.points.map((p) => p.day), ["2028-02-28", "2028-02-29", "2028-03-01"]);
  assert.throws(() => parsePriceGraph(html(["2.28", "2.29", "3.01"], ["1", "2", "3"]), "2027-03-05"),
    /1년보다 길다/, "평년 구간에 2.29 가 나오면 날짜를 지어내지 않는다");
  assert.throws(() => parsePriceGraph(html(["1.01"], ["1", "2"]), "2026-10-02"), ClubParseError);
  assert.throws(() => parsePriceGraph("<div>없음</div>", "2026-10-02"), ClubParseError);
});

test("parseWon", () => {
  assert.equal(parseWon("12,222,552,300"), 12_222_552_300);
  assert.equal(parseWon(""), null);
  assert.equal(parseWon("-"), null);
});
