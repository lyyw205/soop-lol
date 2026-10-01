import assert from "node:assert/strict";
import { test } from "node:test";
import { fcoSeriesStanding } from "./series.ts";

const set = (no: number, a: { ouid: string; streamer_id?: string | null; outcome: string }, b: { ouid: string; streamer_id?: string | null; outcome: string }) => ({
  series_id: "s", series_game_no: no, best_of: 3,
  participants: [{ ...a, nickname: "a", side_no: 1 }, { ...b, nickname: "b", side_no: 2 }],
});

test("같은 스트리머는 계정(ouid)이 달라도 한 쪽으로 합친다 — 부계정·화면 경기", () => {
  const st = fcoSeriesStanding([
    set(1, { ouid: "main", streamer_id: "S1", outcome: "win" }, { ouid: "x", streamer_id: "S2", outcome: "loss" }),
    set(2, { ouid: "alt", streamer_id: "S1", outcome: "win" }, { ouid: "x", streamer_id: "S2", outcome: "loss" }),
  ]);
  assert.equal(st.sides.length, 2);
  assert.equal(st.sides.find((s) => s.key === "streamer:S1")?.set_wins, 2);
  assert.equal(st.clinched, true);
});

test("스트리머가 없으면 예전처럼 ouid 로 묶는다", () => {
  const st = fcoSeriesStanding([
    set(1, { ouid: "p", outcome: "win" }, { ouid: "q", outcome: "loss" }),
    set(2, { ouid: "p", outcome: "loss" }, { ouid: "q", outcome: "win" }),
  ]);
  assert.deepEqual(st.sides.map((s) => s.key).sort(), ["p", "q"]);
  assert.equal(st.leader_key, null);
});
