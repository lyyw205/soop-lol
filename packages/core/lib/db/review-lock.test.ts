import assert from "node:assert/strict";
import { test } from "node:test";

import { autoFillVerdict, decideReviewLock, matchCell, participantCell, type ReviewChangeLike } from "./review-lock.ts";

const reviewed = { reviewed_at: "2026-10-05T00:00:00Z", review_completed_at: null };
const admin = (entity: string, entity_key: string, field: string, after: unknown = 1): ReviewChangeLike =>
  ({ entity, entity_key, field, after, actor: "admin" });

test("검수 안 된 경기는 open — 빈 칸만 채운다", () => {
  const lock = decideReviewLock({ reviewed_at: null, review_completed_at: null }, []);
  assert.equal(lock.mode, "open");
  assert.equal(autoFillVerdict(lock, participantCell(1, "kills"), ["kills"], true), "write");
  assert.equal(autoFillVerdict(lock, participantCell(1, "kills"), ["kills"], false), "occupied");
});

test("사람이 연결만 고친 경기는 칸 단위 — 그 칸만 지키고 다른 빈 칸은 채운다", () => {
  const lock = decideReviewLock(reviewed, [admin("participant", "3", "streamer_id", "s")]);
  assert.equal(lock.mode, "cells");
  assert.equal(autoFillVerdict(lock, participantCell(3, "streamer_id"), ["streamer_id", "puuid"], true), "human");
  assert.equal(autoFillVerdict(lock, participantCell(3, "champion_id"), ["champion_id", "champion_name"], true), "write");
  assert.equal(autoFillVerdict(lock, participantCell(2, "champion_id"), ["champion_id", "champion_name"], true), "write");
  assert.equal(autoFillVerdict(lock, participantCell(2, "kills"), ["kills"], false), "occupied");
});

test("사람이 비운 칸도 사람 것이다 — 비어 있어도 채우지 않는다", () => {
  const lock = decideReviewLock(reviewed, [admin("participant", "5", "kills", null)]);
  assert.equal(autoFillVerdict(lock, participantCell(5, "kills"), ["kills"], true), "human");
});

test("챔피언은 id·이름 중 하나만 사람이 바꿔도 사람 칸", () => {
  const lock = decideReviewLock(reviewed, [admin("participant", "4", "champion_name", "아리")]);
  assert.equal(autoFillVerdict(lock, participantCell(4, "champion_id"), ["champion_id", "champion_name"], true), "human");
});

test("사람이 더한 자리는 행 전체가 사람 것", () => {
  const lock = decideReviewLock(reviewed, [admin("participant", "7", "row", { participant_id: 7 })]);
  assert.equal(autoFillVerdict(lock, participantCell(7, "assists"), ["assists"], true), "human");
  assert.equal(autoFillVerdict(lock, participantCell(8, "assists"), ["assists"], true), "write");
});

test("경기 칸도 같은 주소 — 사람이 고친 경기 시간은 안 채운다", () => {
  const lock = decideReviewLock(reviewed, [admin("match", "m1", "game_duration", null)]);
  assert.equal(autoFillVerdict(lock, matchCell("m1", "game_duration"), ["game_duration"], true), "human");
  assert.equal(autoFillVerdict(lock, matchCell("m1", "series_game_no"), ["series_game_no"], true), "write");
});

test("★ 이력으로 칸을 가릴 수 없는 검수 경기는 전체 보호(과거 잠금 유지)", () => {
  assert.equal(decideReviewLock(reviewed, []).mode, "match");
  // 상태 기록·프레임 기록·자동 기록은 사람이 어느 칸을 바꿨는지 설명하지 않는다.
  assert.equal(decideReviewLock(reviewed, [
    admin("match", "m1", "review_completed", false), admin("frame", "f1", "match_id", "m1"),
    { entity: "participant", entity_key: "1", field: "champion_id", after: 1, actor: "auto" },
  ]).mode, "match");
});

test("관리자 보호 표시·관리자가 만든 경기는 전체 보호, 보호를 끈 뒤 다시 고치면 칸 단위", () => {
  assert.equal(decideReviewLock(reviewed, [admin("participant", "1", "kills"), admin("match", "m1", "admin_protected", true)]).mode, "match");
  assert.equal(decideReviewLock(reviewed, [admin("match", "m1", "created", {})]).mode, "match");
  assert.equal(decideReviewLock(reviewed, [
    admin("match", "m1", "admin_protected", true), admin("match", "m1", "admin_protected", false), admin("participant", "1", "kills"),
  ]).mode, "cells");
});

test("검수 완료 경기는 전체 보호 — 사람이 빈칸을 포함한 현재 값을 확인했다", () => {
  const lock = decideReviewLock({ ...reviewed, review_completed_at: "2026-10-05T01:00:00Z" }, [admin("participant", "1", "streamer_id")]);
  assert.equal(lock.mode, "match");
  assert.equal(autoFillVerdict(lock, participantCell(2, "kills"), ["kills"], true), "match_locked");
});
