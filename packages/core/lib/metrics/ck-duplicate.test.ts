import assert from "node:assert/strict";
import test from "node:test";
import { blindOverlap, duplicateParticipantCounts, isDuplicateGame, withinDuplicateWindow, type DuplicateParticipant } from "./ck-duplicate.ts";

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

// ── 이름 무관 일치(2026-10-09) — 사람 대응이 깨진 같은 판(오독·한쪽만 스트리머 연결)을 잡는다 ──

const renamed = (ps: DuplicateParticipant[]) => ps.map((p, i) => ({ ...p, person_id: i < 3 ? `streamer-${i}` : null, observed_name: `오독${i}` }));

test("이름 무관 일치: 이름·연결 상태가 전부 달라도 (승패·챔피언·KDA) 묶음으로 센다", () => {
  const stored = roster(), mine = renamed(stored).toReversed();
  assert.deepEqual(duplicateParticipantCounts(mine, stored), { kda: 0, champ: 0 });
  assert.equal(blindOverlap(mine, stored), 10);
  assert.equal(isDuplicateGame(null, null, { kda: 0, champ: 0, blind: 10 }), true);
});

test("이름 무관 일치: 8명은 후보, 7명은 아니다", () => {
  const stored = roster();
  const eight = renamed(stored).map((p, i) => i < 8 ? p : { ...p, champion_id: 200 + i });
  const seven = renamed(stored).map((p, i) => i < 7 ? p : { ...p, champion_id: 200 + i });
  assert.equal(blindOverlap(eight, stored), 8);
  assert.equal(blindOverlap(seven, stored), 7);
  assert.equal(isDuplicateGame(null, null, { kda: 0, champ: 0, blind: 8 }), true);
  assert.equal(isDuplicateGame(null, null, { kda: 0, champ: 0, blind: 7 }), false);
});

test("이름 무관 일치: 일부만 읽은 KDA·모르는 챔피언·승패 미상 자리는 세지 않는다", () => {
  const stored = roster();
  const partial = renamed(stored).map((p, i) => i === 0 ? { ...p, assists: null } : i === 1 ? { ...p, champion_id: 0 } : i === 2 ? { ...p, win: null } : p);
  assert.equal(blindOverlap(partial, stored), 7);
  assert.equal(blindOverlap(renamed(stored), stored.map((p, i) => i < 3 ? { ...p, kills: null } : p)), 7);
});

test("이름 무관 일치: 같은 묶음이 반복돼도 상대 쪽 개수만큼만 센다", () => {
  const stored = roster();
  assert.equal(blindOverlap(Array(10).fill(stored[0]), stored), 1);
  const twice = [stored[0], stored[0]];
  assert.equal(blindOverlap(twice, [stored[0], stored[0], stored[1]]), 2);
});

test("이름 무관 일치: 승패가 뒤집히면(다른 판) 세지 않고, 양쪽 길이가 다르면 일치 수와 무관하게 다른 판이다", () => {
  const stored = roster();
  assert.equal(blindOverlap(stored.map((p) => ({ ...p, win: !p.win })), stored), 0);
  assert.equal(isDuplicateGame(1500, 1503, { kda: 0, champ: 0, blind: 10 }), false);
  assert.equal(isDuplicateGame(1500, 1502, { kda: 0, champ: 0, blind: 8 }), true);
  assert.equal(isDuplicateGame(1500, null, { kda: 0, champ: 0, blind: 8 }), true);
});

test("시간 범위: 시각을 알면 ±20분(자정을 넘어도), 날짜만 알면 같은 KST 날짜", () => {
  const at = (iso: string) => new Date(iso);
  const t = (iso: string, precision = "datetime") => ({ at: at(iso), precision });
  // 23:55 KST 와 00:05 KST — 날짜가 달라도 시각을 아니 같은 범위
  assert.equal(withinDuplicateWindow(t("2030-01-01T14:55:00Z"), t("2030-01-01T15:05:00Z")), true);
  assert.equal(withinDuplicateWindow(t("2030-01-01T15:05:00Z"), t("2030-01-01T14:55:00Z")), true);
  assert.equal(withinDuplicateWindow(t("2030-01-01T12:00:00Z"), t("2030-01-01T12:20:00Z")), true);
  assert.equal(withinDuplicateWindow(t("2030-01-01T12:00:00Z"), t("2030-01-01T12:20:01Z")), false);
  // 날짜만 아는 기록은 KST 날짜로 — 자정을 넘으면 다른 날
  assert.equal(withinDuplicateWindow(t("2030-01-01T14:55:00Z", "date"), t("2030-01-01T15:05:00Z")), false);
  assert.equal(withinDuplicateWindow(t("2030-01-01T00:30:00Z", "date"), t("2030-01-01T14:30:00Z")), true);
});
