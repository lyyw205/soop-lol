import assert from "node:assert/strict";
import { test } from "node:test";

import { matchEvidence, nextUncompleted, representativeEvidence, visibleEvidence, workPosition, type EvidenceVodInput } from "./ck-match-review.ts";

const items = [
  { match_id: "a", completed: true }, { match_id: "b", completed: false },
  { match_id: "c", completed: true }, { match_id: "d", completed: false },
];

test("작업 목록: 앞뒤는 목록 순서 그대로, 목록 밖이면 자리가 없다", () => {
  assert.deepEqual(workPosition(items, "b"), { index: 1, total: 4, prev: "a", next: "c" });
  assert.deepEqual(workPosition(items, "a"), { index: 0, total: 4, prev: null, next: "b" });
  assert.deepEqual(workPosition(items, "d"), { index: 3, total: 4, prev: "c", next: null });
  assert.deepEqual(workPosition(items, "x"), { index: -1, total: 4, prev: null, next: null });
});

test("완료 후 이동: 같은 목록에서 다음 미완료 — 완료된 세트는 건너뛰고 끝나면 앞에서부터", () => {
  assert.equal(nextUncompleted(items, "b"), "d", "완료된 c 를 건너뛴다");
  assert.equal(nextUncompleted(items, "d"), "b", "끝까지 없으면 앞에서부터");
  assert.equal(nextUncompleted([{ match_id: "b", completed: false }], "b"), null, "자기 자신은 다음이 아니다");
  assert.equal(nextUncompleted(items, "x"), "b", "목록 밖에서 열었으면 처음부터");
});

const f = (id: string, at_sec: number | null, match_id: string | null = null, kind: "result" | "roster" | "other" = "other") =>
  ({ id, match_id, frame_path: `out/${id}.jpg`, at_sec, kind });
const vod = (lead_id: string, frames: ReturnType<typeof f>[], role: "created" | "added" | null, matches = [
  { match_id: "M", game_creation_epoch_ms: 0, game_duration: 1800 },
  { match_id: "N", game_creation_epoch_ms: 0, game_duration: 1800 },
]): EvidenceVodInput => ({ lead_id, vod_started_at: null, frames, matches, pov: role ? { role } : null });

test("근거: 연결 사진(모든 방송) + 같은 구간의 미연결 참고 사진을 구별해 모은다", () => {
  const a = vod("A", [
    f("ban", 1000), f("game", 2000), f("result", 3500, "M", "result"),  // M 구간: 3500-1800-600=1100 ~ 3500
    f("before", 500), f("next-result", 9000, "N", "result"), f("after", 8000),
  ], "added");
  const b = vod("B", [f("b-result", 700, "M", "result")], "created");
  const evidence = matchEvidence("M", [a, b]);
  assert.deepEqual(evidence.map((e) => e.vod.lead_id), ["B", "A"], "경기를 만든 방송이 먼저");
  const fromA = evidence[1];
  assert.deepEqual(fromA.frames.map((x) => [x.id, x.linked]), [["game", false], ["result", true]],
    "구간 밖(ban·before)과 다른 경기 구간(after·next-result)은 빠진다");
  assert.equal(fromA.linked, 1);
  assert.equal(fromA.reference, 1);
});

test("근거: 시점 기록 없이 사진만 연결된 방송도 근거로 나온다(입력에 있으면 그대로)", () => {
  const evidence = matchEvidence("M", [vod("A", [f("r", 100, "M", "result")], null)]);
  assert.deepEqual(evidence[0].frames.map((x) => x.id), ["r"]);
});

test("방송 필터는 보이는 사진만 고르고, 사진이 없는 방송은 빈 목록이다", () => {
  const evidence = matchEvidence("M", [
    vod("A", [f("a1", 3400, "M", "result")], "created"),
    vod("B", [], "added"),
  ]);
  assert.deepEqual(visibleEvidence(evidence, null).map((x) => x.id), ["a1"]);
  assert.deepEqual(visibleEvidence(evidence, "A").map((x) => x.id), ["a1"]);
  assert.deepEqual(visibleEvidence(evidence, "B"), [], "이 방송의 근거 없음");
});

test("처음 띄울 사진: 연결된 결과창 → 연결 사진 → 첫 사진", () => {
  const linkedOther = { ...f("o", 1, "M"), lead_id: "A", linked: true };
  const reference = { ...f("ref", 0, null, "result"), lead_id: "A", linked: false };
  const linkedResult = { ...f("r", 2, "M", "result"), lead_id: "A", linked: true };
  assert.equal(representativeEvidence([reference, linkedOther, linkedResult])?.id, "r");
  assert.equal(representativeEvidence([reference, linkedOther])?.id, "o", "참고 결과창보다 연결 사진이 먼저");
  assert.equal(representativeEvidence([reference])?.id, "ref");
  assert.equal(representativeEvidence([]), null);
});
