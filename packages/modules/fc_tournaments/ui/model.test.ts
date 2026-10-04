import { test } from "node:test";
import assert from "node:assert/strict";
import type { FcoGame, FcoParticipant } from "@soop-lol/core/lib/contract";
import { cardRecords, entrants, headToHead, highlights, isLevelDecided, MIN_RATED_GAMES } from "./model.ts";

function side(id: string | null, side_no: number, outcome: FcoParticipant["outcome"], score: number, extra: Partial<FcoParticipant> = {}): FcoParticipant {
  return {
    ouid: id ? `ouid-${id}` : `unlinked:${side_no}`, nickname: id ?? "상대", streamer_id: id, streamer_slug: id,
    streamer_name: id, side_no, outcome, goals: score, score_display: score, division: null, match_info: {}, ...extra,
  };
}
const game = (id: string, ...participants: FcoParticipant[]): FcoGame => ({
  id, provider_id: `p-${id}`, played_at: "2026-08-25T08:00:00Z", mode_key: "40", event_id: "e", event_name: "e",
  event_slug: "e", series_id: null, series_game_no: null, best_of: null, participants,
});

test("기록은 이름순이고(순위가 아니다) 표시 점수로 득실을 센다", () => {
  const rows = entrants([
    game("1", side("a", 1, "win", 3), side("b", 2, "loss", 1)),
    game("2", side("b", 1, "win", 2), side("c", 2, "loss", 0)),
    // 몰수처럼 goals 와 화면 점수가 다른 경기 — 화면 점수가 우선이다.
    game("3", side("c", 1, "win", 1, { goals: 0, score_display: 1 }), side("a", 2, "loss", 0)),
  ]);
  assert.deepEqual(rows.map((r) => [r.key, r.wins, r.goalsFor, r.goalsAgainst]), [
    ["a", 1, 3, 2], ["b", 1, 3, 3], ["c", 1, 1, 2],
  ]);
  assert.deepEqual(rows[0].form, ["win", "loss"]);
});

test("미연결 상대는 성적·전적표에서 빠진다 — 서로 다른 사람을 한 줄로 합치지 않는다", () => {
  const games = [
    game("1", side("a", 1, "win", 2), side(null, 2, "loss", 0)),
    game("2", side(null, 1, "win", 5), side("a", 2, "loss", 1)),
  ];
  assert.deepEqual(entrants(games).map((r) => r.key), ["a"]);
  assert.equal(headToHead(games).size, 0);
});

test("상대 전적표는 양쪽 입장을 모두 채운다", () => {
  const m = headToHead([
    game("1", side("a", 1, "win", 2), side("b", 2, "loss", 1)),
    game("2", side("b", 1, "win", 4), side("a", 2, "loss", 0)),
  ]);
  assert.deepEqual(m.get("a")?.get("b")?.map((r) => [r.own, r.rival, r.outcome]), [[2, 1, "win"], [0, 4, "loss"]]);
  assert.deepEqual(m.get("b")?.get("a")?.map((r) => r.outcome), ["loss", "win"]);
});

test("같은 점수로 승패가 갈린 경기를 알아본다", () => {
  assert.equal(isLevelDecided(game("1", side("a", 1, "win", 3), side("b", 2, "loss", 3))), true);
  assert.equal(isLevelDecided(game("2", side("a", 1, "draw", 1), side("b", 2, "draw", 1))), false);
  assert.equal(isLevelDecided(game("3", side("a", 1, "win", 2), side("b", 2, "loss", 1))), false);
});

test("평균 평점 1위는 최소 출전 수를 채운 카드만 오른다", () => {
  const roster = (rating: number) => ({ player: [{ spId: 101, status: { goal: 1, spRating: rating } }] });
  const flash = (id: string) => ({ player: [{ spId: 202, status: { goal: 0, spRating: id === "g1" ? 10 : 0 } }] });
  const games = Array.from({ length: MIN_RATED_GAMES }, (_, i) =>
    game(`g${i + 1}`, side("a", 1, "win", 1, { match_info: roster(7) }), side("b", 2, "loss", 0, { match_info: flash(`g${i + 1}`) })));
  const cards = cardRecords(games);
  const h = highlights(games, entrants(games), cards);
  assert.equal(h.topCard?.playerId, 101);
  assert.equal(h.bestRated?.playerId, 101); // 202 는 평점 10 이 한 경기뿐이다
  assert.equal(h.biggestWin?.margin, 1);
});
