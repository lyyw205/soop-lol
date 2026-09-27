import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSortState, sortStreamerCards, type SortableStreamer } from "./streamer-sort.ts";

const person = (display_name: string, lp_absolute: number | null = null): SortableStreamer =>
  ({ display_name, lp_absolute });

test("머리글은 내림차순 → 오름차순 → 해제 로 돈다", () => {
  assert.deepEqual(nextSortState({}, "tier"), { sort: "tier", dir: "desc" });
  assert.deepEqual(nextSortState({ sort: "tier", dir: "desc" }, "tier"), { sort: "tier", dir: "asc" });
  assert.deepEqual(nextSortState({ sort: "tier", dir: "asc" }, "tier"), {});
  // 다른 열을 누르면 그 열의 내림차순부터 다시 시작한다.
  assert.deepEqual(nextSortState({ sort: "tier", dir: "asc" }, "name"), { sort: "name", dir: "desc" });
});

test("정렬을 안 걸면 받은 순서를 그대로 쓴다 (질의가 정한 기본 순서)", () => {
  const rows = [person("나"), person("가"), person("다")];
  assert.deepEqual(sortStreamerCards(rows).map((r) => r.display_name), ["나", "가", "다"]);
  // 원본을 건드리지 않는다.
  assert.equal(rows[0].display_name, "나");
});

test("★ 티어가 없는 사람은 방향과 무관하게 끝으로 간다", () => {
  const rows = [person("언랭", null), person("골드", 1200), person("실버", 800)];
  // 오름차순이라고 '언랭' 을 1위로 올리면 화면이 거짓말을 한다 — 낮은 게 아니라 없는 거다.
  assert.deepEqual(sortStreamerCards(rows, "tier", "asc").map((r) => r.display_name), ["실버", "골드", "언랭"]);
  assert.deepEqual(sortStreamerCards(rows, "tier", "desc").map((r) => r.display_name), ["골드", "실버", "언랭"]);
});

test("티어가 전부 없으면(지금 상태) 이름순으로 떨어진다", () => {
  // Riot 키가 없어 rank_snapshot 이 비어 있다. 그때도 순서가 흔들리면 안 된다.
  const rows = [person("다"), person("가"), person("나")];
  assert.deepEqual(sortStreamerCards(rows, "tier", "desc").map((r) => r.display_name), ["가", "나", "다"]);
});

test("값이 같으면 이름으로 가른다 — 순서가 매번 흔들리지 않아야 한다", () => {
  const rows = [person("다", 900), person("가", 900), person("나", 900)];
  assert.deepEqual(sortStreamerCards(rows, "tier", "desc").map((r) => r.display_name), ["가", "나", "다"]);
  assert.deepEqual(sortStreamerCards(rows, "tier", "asc").map((r) => r.display_name), ["가", "나", "다"]);
});

test("이름 정렬은 한국어 순서를 따른다", () => {
  const rows = [person("하늘"), person("가람"), person("나무")];
  assert.deepEqual(sortStreamerCards(rows, "name", "asc").map((r) => r.display_name), ["가람", "나무", "하늘"]);
  assert.deepEqual(sortStreamerCards(rows, "name", "desc").map((r) => r.display_name), ["하늘", "나무", "가람"]);
});
