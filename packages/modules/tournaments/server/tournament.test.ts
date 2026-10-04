import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tournamentSeries,
  tournamentPlayerRecords,
  tournamentCategory,
  laneDuels,
  tournamentHighlights,
  type TournamentMatchRow,
} from "./tournament.ts";
import type { PublicRosterEntry } from "@soop-lol/core/lib/contract";
const row = (patch: Partial<TournamentMatchRow> = {}): TournamentMatchRow => ({
  match_id: "s1",
  series_id: "final",
  series_game_no: 1,
  game_creation: new Date("2026-08-01T15:30:00Z"),
  game_creation_precision: "date",
  game_duration: 1800,
  winning_team: 100,
  blue_team_id: "a",
  red_team_id: "b",
  blue_name: "A",
  red_name: "B",
  best_of: 3,
  set_order_known: false,
  round_label: "결승",
  source_url: null,
  ...patch,
});
test("series scores follow stable team IDs when sides change", () => {
  const [s] = tournamentSeries(
    [
      row(),
      row({
        match_id: "s2",
        series_game_no: 2,
        blue_team_id: "b",
        red_team_id: "a",
        blue_name: "B",
        red_name: "A",
        winning_team: 200,
      }),
    ],
    [],
  );
  assert.equal(s.scoreA, 2);
  assert.equal(s.scoreB, 0);
  assert.equal(s.date, "2026-08-02");
  assert.equal(s.sets[0].label, "세트");
  assert.equal(s.sets[1].blueName, "B");
});
test("missing or inconsistent team ownership cannot fabricate a multi-set series score", () => {
  for (const patch of [
    { blue_team_id: null, red_team_id: null },
    { blue_team_id: "c", blue_name: "C" },
    { winning_team: null },
  ]) {
    const [s] = tournamentSeries(
      [row(), row({ match_id: "s2", ...patch })],
      [],
    );
    assert.equal(s.scoreA, null);
    assert.equal(s.scoreB, null);
  }
});
test("one collected set of a BO3 is not relabelled as a standalone match", () => {
  const [s] = tournamentSeries([row()], []);
  assert.equal(s.sets[0].label, "세트");
  assert.equal(
    tournamentSeries([row({ series_id: null })], [])[0].sets[0].label,
    "단판",
  );
  assert.equal(
    tournamentSeries([row({ set_order_known: true, series_game_no: 2 })], [])[0]
      .sets[0].label,
    "2세트",
  );
});
test("player aggregation excludes incomplete KDA and unlinked names; champions retain confirmed picks", () => {
  const p: PublicRosterEntry = {
    match_id: "s1",
    participant_id: 1,
    streamer_id: "person",
    slug: "person",
    display_name: "선수",
    observed_name: null,
    team_id: 100,
    team_name: "A",
    team_position: "TOP",
    champion_id: 1,
    champion_name: "Annie",
    outcome: "win",
    kills: 2,
    deaths: 0,
    assists: 5,
  };
  const roster = [
    p,
    { ...p, match_id: "s2", kills: null },
    {
      ...p,
      participant_id: 2,
      streamer_id: null,
      slug: null,
      display_name: null,
      observed_name: "같은 이름",
    },
  ];
  const stats = tournamentPlayerRecords(
    tournamentSeries([row(), row({ match_id: "s2" })], roster),
  );
  assert.equal(stats.players.length, 1);
  assert.equal(stats.players[0].games, 2);
  assert.equal(stats.players[0].known, 1);
  assert.equal(stats.players[0].kills, 2);
  assert.equal(stats.champions[0].picks, 3);
});
test("all-star and invitation events share the event tab without changing stored kind", () => {
  assert.equal(tournamentCategory("meljang-2026-geng", "tournament"), "meljang");
  assert.equal(tournamentCategory("meljang-2024-allstar", "tournament"), "event");
  assert.equal(tournamentCategory("junggangye-2026-viper", "tournament"), "event");
  assert.equal(tournamentCategory("ck-2026-09-19", "ck"), "ck");
  assert.equal(tournamentCategory("custom-slug", "ck"), "ck");
});

/* ── 기록실: 맞라인 대결 · 명기록 ─────────────────────────────────────── */

const player = (match_id: string, team_id: 100 | 200, pos: PublicRosterEntry["team_position"], id: string | null, outcome: "win" | "loss",
  extra: Partial<PublicRosterEntry> = {}): PublicRosterEntry => ({
  match_id, participant_id: 0, streamer_id: id, slug: id, display_name: id, observed_name: id ? null : "미등록",
  team_id, team_name: null, team_position: pos, champion_id: 1, champion_name: "Annie", outcome,
  kills: 1, deaths: 1, assists: 1, ...extra,
});

test("맞라인 대결: 같은 포지션 두 스트리머의 세트 팀 승패를 진영과 무관하게 한 줄로 모은다", () => {
  const series = tournamentSeries(
    [row(), row({ match_id: "s2", series_game_no: 2, blue_team_id: "b", red_team_id: "a", winning_team: 100 })],
    [
      // 1세트: 청(A팀) 승 — 탑 가나 vs 다라
      player("s1", 100, "TOP", "가나", "win"), player("s1", 200, "TOP", "다라", "loss"),
      // 2세트: 진영이 바뀌었고 청(B팀) 승 — 다라가 이겼다
      player("s2", 100, "TOP", "다라", "win"), player("s2", 200, "TOP", "가나", "loss"),
      // 미등록·포지션 모름은 세지 않는다
      player("s1", 100, "MIDDLE", null, "win"), player("s1", 200, "MIDDLE", "마바", "loss"),
      player("s2", 100, null, "사아", "win"), player("s2", 200, null, "자차", "loss"),
    ],
  );
  const duels = laneDuels(series);
  assert.equal(duels.length, 1);
  const [d] = duels;
  assert.equal(d.position, "TOP");
  assert.deepEqual([d.a.name, d.aWins, d.bWins, d.b.name], ["가나", 1, 1, "다라"]); // 1:1 이면 이름순
  assert.deepEqual(d.sets.map((x) => x.winner), ["a", "b"]);
});

test("맞라인 대결: 이긴 세트가 많은 쪽이 왼쪽(a)이고 세트 기록도 그 기준으로 뒤집힌다", () => {
  const series = tournamentSeries(
    [row(), row({ match_id: "s2", series_game_no: 2 })],
    [
      player("s1", 100, "UTILITY", "하", "loss"), player("s1", 200, "UTILITY", "가", "win", { kills: 7 }),
      player("s2", 100, "UTILITY", "하", "loss"), player("s2", 200, "UTILITY", "가", "win"),
    ],
  );
  const [d] = laneDuels(series);
  assert.deepEqual([d.a.name, d.aWins, d.bWins], ["가", 2, 0]);
  assert.equal(d.sets[0].a.kills, 7);
  assert.deepEqual(d.sets.map((x) => x.winner), ["a", "a"]);
});

test("명기록: 최장 경기는 시간이 확인된 세트만 · 최다 킬은 킬이 확인된 기록만 · 챔피언 종류", () => {
  const series = tournamentSeries(
    [row({ game_duration: 2000 }), row({ match_id: "s2", series_game_no: 2, game_duration: null }), row({ match_id: "s3", series_game_no: 3, game_duration: 3965 })],
    [
      player("s1", 100, "TOP", "가", "win", { kills: 12, champion_id: 10 }),
      player("s2", 100, "TOP", "나", "win", { kills: null, champion_id: 10 }),
      player("s3", 100, "TOP", "다", "win", { kills: 12, champion_id: 11 }),
    ],
  );
  const h = tournamentHighlights(series);
  assert.deepEqual([h.longest?.seconds, h.longest?.known, h.longest?.total, h.longest?.setIndex], [3965, 2, 3, 2]);
  assert.deepEqual([h.mostKills?.name, h.mostKills?.kills, h.mostKills?.ties], ["가", 12, 1]);
  assert.deepEqual(h.champions, { kinds: 2, picks: 3, once: 1 });
});
