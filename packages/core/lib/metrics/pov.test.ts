import assert from "node:assert/strict";
import { test } from "node:test";

import {
  comparePov, fillPlan, identKey, matchParticipant, mergeObserved, summarizeComparison,
  type StoredMatch, type StoredParticipant,
} from "./pov.ts";

const T0 = "2026-09-26T12:00:00.000Z";
const T1 = "2026-09-26T13:00:00.000Z";

const row = (id: number, person: string, team: 100 | 200, extra: Partial<StoredParticipant> = {}): StoredParticipant => ({
  participant_id: id, person_id: person, puuid: null, observed_name: null, team_id: team,
  team_position: null, champion_id: 0, kills: null, deaths: null, assists: null, ...extra,
});

const stored = (over: Partial<StoredMatch> = {}): StoredMatch => ({
  winning_team: 200, game_duration: 1865, series_id: "s", series_game_no: 1, review_completed_at: null,
  participants: [
    row(1, "A", 100, { champion_id: 516, kills: 2, deaths: 6, assists: 2 }),
    row(2, "B", 100, { champion_id: 64, kills: 3, deaths: 6, assists: 5 }),
    row(6, "C", 200, { champion_id: 150, kills: 9, deaths: 0, assists: 10 }),
    row(7, "D", 200, { champion_id: 0 }), // 챔피언 빈 칸
    row(9, "E", 200, { observed_name: "붕어에몽", person_id: null, champion_id: 145, kills: 10, deaths: 4, assists: 5 }),
  ],
  ...over,
});

test("사람 키 — 사람·계정이 이름보다 먼저", () => {
  assert.equal(identKey({ streamer_id: "x", observed_name: "y" }), "s:x");
  assert.equal(identKey({ puuid: "p" }), "p:p");
  assert.equal(identKey({ observed_name: " 붕어 에몽 " }), "n:붕어에몽");
  assert.equal(identKey({}), null);
});

test("같은 값을 읽으면 일치", () => {
  const { observed } = mergeObserved({}, {
    match: { winning_team: 200, duration: 1860 },
    participants: [{ ident: { streamer_id: "C" }, team: 200, champion_id: 150, kills: 9, deaths: 0, assists: 10 }],
  }, T0);
  const s = summarizeComparison(comparePov(stored(), observed));
  assert.equal(s.mismatch_open, 0);
  assert.equal(s.agree, 7); // 승자·길이(±10초)·팀·챔피언·K·D·A
});

test("팀 순서가 뒤집힌 시점 — 사람으로 대응하므로 일치", () => {
  // 이 시점은 자기 팀(경기 200)을 100 이라고 불렀다.
  const { observed } = mergeObserved({}, {
    match: { winning_team: 100 },
    participants: [
      { ident: { streamer_id: "C" }, team: 100 },
      { ident: { streamer_id: "A" }, team: 200 },
    ],
  }, T0);
  const cmp = comparePov(stored(), observed);
  assert.deepEqual(cmp.team_map, { 100: 200, 200: 100 });
  assert.equal(summarizeComparison(cmp).mismatch_open, 0);
});

test("0 은 읽은 값, 생략은 안 읽음", () => {
  const { observed } = mergeObserved({}, { participants: [{ ident: { streamer_id: "C" }, deaths: 0 }] }, T0);
  const items = comparePov(stored(), observed).items;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].field, items[0].status], ["deaths", "agree"]);
});

test("다른 값은 불일치 — 검수 완료 시각이 제출보다 나중이면 '검수 완료'", () => {
  const { observed } = mergeObserved({}, { participants: [{ ident: { streamer_id: "C" }, kills: 8 }] }, T0);
  assert.equal(summarizeComparison(comparePov(stored(), observed)).mismatch_open, 1);
  const s = summarizeComparison(comparePov(stored({ review_completed_at: T1 }), observed));
  assert.deepEqual([s.mismatch_open, s.mismatch_reviewed], [0, 1]);
});

test("검수 완료 뒤 새로 낸 다른 값은 다시 미해결", () => {
  const first = mergeObserved({}, { participants: [{ ident: { streamer_id: "C" }, kills: 8 }] }, T0).observed;
  const later = mergeObserved(first, { participants: [{ ident: { streamer_id: "C" }, kills: 7 }] }, "2026-09-26T14:00:00.000Z").observed;
  assert.equal(summarizeComparison(comparePov(stored({ review_completed_at: T1 }), later)).mismatch_open, 1);
});

test("같은 값 재전송은 제출 시각을 옮기지 않는다 — 확인한 불일치가 되살아나지 않게", () => {
  const first = mergeObserved({}, { participants: [{ ident: { streamer_id: "C" }, kills: 8 }] }, T0);
  const again = mergeObserved(first.observed, { participants: [{ ident: { streamer_id: "C" }, kills: 8 }] }, "2026-09-26T14:00:00.000Z");
  assert.equal(again.history.length, 0);
  assert.equal(summarizeComparison(comparePov(stored({ review_completed_at: T1 }), again.observed)).mismatch_open, 0);
});

test("부분 재제출은 보낸 칸만 바꾸고, 바뀐 값은 이력에 남긴다", () => {
  const first = mergeObserved({}, { participants: [{ ident: { streamer_id: "C" }, champion_id: 150, kills: 8 }] }, T0).observed;
  const { observed, history } = mergeObserved(first, { participants: [{ ident: { streamer_id: "C" }, kills: 9 }] }, T1);
  assert.equal(observed.participants!["s:C"].champion_id!.v, 150); // 챔피언 관측 유지
  assert.equal(observed.participants!["s:C"].kills!.v, 9);
  assert.deepEqual(history.map((h) => [h.field, h.before, h.after]), [["kills", 8, 9]]);
});

test("null 은 철회 — 이력에 남는다", () => {
  const first = mergeObserved({}, { match: { duration: 1800 } }, T0).observed;
  const { observed, history } = mergeObserved(first, { match: { duration: null } }, T1);
  assert.equal(observed.match!.duration, undefined);
  assert.deepEqual(history.map((h) => [h.field, h.before, h.after]), [["duration", 1800, null]]);
});

test("빈 칸은 채울 수 있다 — 대응이 확실할 때만", () => {
  const { observed } = mergeObserved({}, {
    participants: [
      { ident: { streamer_id: "D" }, team: 200, champion_id: 875 },
      { ident: { observed_name: "모르는사람" }, champion_id: 1 },
    ],
  }, T0);
  const cmp = comparePov(stored(), observed);
  assert.deepEqual(cmp.unmatched, ["n:모르는사람"]);
  assert.deepEqual(fillPlan(cmp), [{ scope: "participant", participant_id: 7, field: "champion_id", value: 875 }]);
});

test("이름으로도 대응한다(미등록 참가자) — 공백·대소문자 무시", () => {
  const hit = matchParticipant({ observed_name: "붕어 에몽" }, stored().participants);
  assert.equal(hit?.participant_id, 9);
});

test("팀 대응이 안 되면 승자·팀은 비교하지 않는다(pending)", () => {
  const { observed } = mergeObserved({}, { match: { winning_team: 100 } }, T0);
  const [item] = comparePov(stored(), observed).items;
  assert.equal(item.status, "pending");
});

test("한 이름표에 두 팀이 섞이면 팀 대응을 버린다", () => {
  const { observed } = mergeObserved({}, {
    match: { winning_team: 100 },
    participants: [
      { ident: { streamer_id: "A" }, team: 100 },
      { ident: { streamer_id: "C" }, team: 100 },
    ],
  }, T0);
  const cmp = comparePov(stored(), observed);
  assert.deepEqual(cmp.team_map, { 100: null, 200: null });
  assert.ok(cmp.items.every((i) => i.status === "pending"));
});

test("세트 번호는 시리즈가 없으면 비교하지 않는다", () => {
  const { observed } = mergeObserved({}, { match: { series_game_no: 2 } }, T0);
  const [item] = comparePov(stored({ series_id: null, series_game_no: null }), observed).items;
  assert.equal(item.status, "pending");
});
