import assert from "node:assert/strict";
import test from "node:test";
import { duplicateParticipantCounts, isDuplicateGame, type DuplicateParticipant } from "./ck-duplicate.ts";

const person = (i: number, extra: Partial<DuplicateParticipant> = {}): DuplicateParticipant => ({
  person_id: null, puuid: null, observed_name: `사람${i}`, win: i < 5,
  champion_id: i + 1, kills: i, deaths: i + 1, assists: i + 2, ...extra,
});
const roster = () => Array.from({ length: 10 }, (_, i) => person(i));

test("같은 사람은 줄 순서·진영과 무관하게 대응하고 이름의 공백·유니코드를 정규화한다", () => {
  const stored = roster();
  const mine = stored.toReversed().map((p) => ({ ...p, observed_name: ` ${p.observed_name!.normalize("NFD")} ` }));
  assert.deepEqual(duplicateParticipantCounts(mine, stored), { kda: 10, champ: 10 });
});

test("다른 사람이 같은 챔피언·KDA·승패를 기록해도 일치로 세지 않는다", () => {
  const other = roster().map((p) => ({ ...p, observed_name: `다른${p.observed_name}` }));
  assert.deepEqual(duplicateParticipantCounts(other, roster()), { kda: 0, champ: 0 });
});

test("확인된 사람·계정이 다르면 같은 이름으로 대응하지 않는다; 같은 사람의 부계정은 대응한다", () => {
  const a = person(0, { person_id: "a", puuid: "account-a" });
  assert.deepEqual(duplicateParticipantCounts([person(0, { person_id: "b" })], [a]), { kda: 0, champ: 0 });
  assert.deepEqual(duplicateParticipantCounts([person(0, { puuid: "account-b" })], [a]), { kda: 0, champ: 0 });
  assert.deepEqual(duplicateParticipantCounts([person(0, { person_id: "a", puuid: "account-alt" })], [a]), { kda: 1, champ: 1 });
});

test("같은 KDA를 가진 두 기존 사람을 열 사람과 매칭해 부풀리지 않는다", () => {
  const stored = roster();
  const mine = stored.map((p, i) => ({ ...p, champion_id: 100 + i,
    kills: i < 5 ? 0 : 5, deaths: i < 5 ? 1 : 6, assists: i < 5 ? 2 : 7 }));
  assert.deepEqual(duplicateParticipantCounts(mine, stored), { kda: 2, champ: 0 });
  assert.deepEqual(duplicateParticipantCounts(Array(10).fill(person(0)), stored), { kda: 1, champ: 1 });
});

test("모호한 이름·신원 미상·승패 미상·불완전 KDA를 일치로 세지 않는다", () => {
  assert.deepEqual(duplicateParticipantCounts([person(0)], [person(0), person(0)]), { kda: 0, champ: 0 });
  assert.deepEqual(duplicateParticipantCounts([person(0, { observed_name: null })], [person(0)]), { kda: 0, champ: 0 });
  assert.deepEqual(duplicateParticipantCounts([person(0, { win: null })], [person(0)]), { kda: 0, champ: 0 });
  assert.deepEqual(duplicateParticipantCounts([person(0, { assists: null })], [person(0)]), { kda: 0, champ: 1 });
  assert.deepEqual(duplicateParticipantCounts([person(0)], [person(0, { assists: null })]), { kda: 0, champ: 1 });
});

test("양쪽 시간을 알면 ±2초·6명 기준이고 서로 다른 시간은 미상 기준으로 넘어가지 않는다", () => {
  assert.equal(isDuplicateGame(1500, 1502, { kda: 6, champ: 0 }), true);
  assert.equal(isDuplicateGame(1500, 1498, { kda: 0, champ: 6 }), true);
  assert.equal(isDuplicateGame(1500, 1500, { kda: 5, champ: 5 }), false);
  assert.equal(isDuplicateGame(1500, 1503, { kda: 10, champ: 10 }), false);
  assert.equal(isDuplicateGame(1500, 1800, { kda: 10, champ: 10 }), false);
});

test("어느 한쪽 시간을 모르면 두 기준 모두 8명 이상이어야 한다", () => {
  for (const [a, b] of [[null, 1500], [1500, null], [null, null]] as const) {
    assert.equal(isDuplicateGame(a, b, { kda: 8, champ: 8 }), true);
    assert.equal(isDuplicateGame(a, b, { kda: 7, champ: 10 }), false);
    assert.equal(isDuplicateGame(a, b, { kda: 10, champ: 7 }), false);
  }
});
