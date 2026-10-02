import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChallenge, gameTags, progressAt, type ChallengeDef } from "./model.ts";

const def: ChallengeDef = {
  slug: "t", title: "t", summary: "", goal: { tier: "MASTER" }, since: "2026-09-01",
  members: [
    { streamer: "a", name: "가", role: "탑", color: "orange", puuid: "pa" },
    { streamer: "b", name: "나", role: "미드", color: "blue", puuid: "pb" },
  ],
};
const row = (match: string, puuid: string, win: boolean, ch: Record<string, number>, at = "2026-09-10T12:00:00Z") => ({
  match_id: match, puuid, streamer_id: puuid, queue_id: 420, game_creation: new Date(at), game_duration: 1800, ended_in_surrender: false,
  team_id: 100, team_position: "TOP", champion_id: 75, champion_name: "Nasus", outcome: win ? "win" : "loss",
  kills: 3, deaths: 2, assists: 4, cs: 200, damage_to_champions: 20000, vision_score: 20, challenges: ch,
});

test("진행 막대 위치 — 바닥과 목표 사이 비율, 넘치면 끝에 붙는다", () => {
  assert.equal(progressAt(2400, 2000, 2800), 50);
  assert.equal(progressAt(3000, 2000, 2800), 100);
  assert.equal(progressAt(1900, 2000, 2800), 0);
});

test("목표까지 남은 LP·바닥은 가장 낮은 멤버의 티어 시작", () => {
  const v = buildChallenge(def, [], [
    { puuid: "pa", streamer_id: "a", snapshot_date: "2026-10-02", tier: "EMERALD", division: "III", league_points: 95, wins: 56, losses: 53, lp_absolute: 2195 },
    { puuid: "pb", streamer_id: "b", snapshot_date: "2026-10-02", tier: "EMERALD", division: "IV", league_points: 0, wins: 56, losses: 53, lp_absolute: 2000 },
  ], []);
  assert.equal(v.goalAbs, 2800);
  assert.deepEqual(v.members.map((m) => m.rank?.toGoal), [605, 800]);
  assert.equal(v.floorAbs, 2000);
  assert.equal(v.riotGames, 109);
});

test("같은 판의 두 멤버는 한 판 · 같이 한 판에서 딜을 더 넣은 쪽을 센다", () => {
  const v = buildChallenge(def, [
    row("m1", "pa", true, { teamDamagePercentage: 0.3, soloKills: 4 }), row("m1", "pb", true, { teamDamagePercentage: 0.2 }),
    row("m2", "pa", false, { teamDamagePercentage: 0.1 }, "2026-09-10T13:00:00Z"), row("m2", "pb", false, { teamDamagePercentage: 0.25 }, "2026-09-10T13:00:00Z"),
  ], [], []);
  assert.equal(v.games.length, 2);
  assert.deepEqual([v.record.together, v.record.togetherWins], [2, 1]);
  assert.deepEqual(v.stats.map((s) => s.moreDamage), [1, 1]);
  assert.ok(v.games[0].tags.includes("가 솔킬 4") && v.games[0].tags.includes("가 딜 30%"));
});

test("챔피언 승률은 표본이 작으면 50%쪽으로 — 3승 0패는 100%가 아니다", () => {
  const v = buildChallenge(def, [1, 2, 3].map((i) => row(`m${i}`, "pa", true, {}, `2026-09-1${i}T12:00:00Z`)), [], []);
  const c = v.stats[0].champs[0];
  assert.deepEqual([c.wins, c.losses], [3, 0]);
  assert.ok(c.shrunk < 0.75 && c.shrunk > 0.5);
});

test("서렌 패만 서렌 태그", () => {
  assert.deepEqual(gameTags({ lines: [null], win: false, surrender: true }, [{ name: "가" }]), ["서렌"]);
  assert.deepEqual(gameTags({ lines: [null], win: true, surrender: true }, [{ name: "가" }]), []);
});
