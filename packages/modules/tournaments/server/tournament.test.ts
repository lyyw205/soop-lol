import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tournamentSeries,
  tournamentPlayerRecords,
  tournamentCategory,
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
