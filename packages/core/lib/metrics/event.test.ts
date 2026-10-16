import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTeamStage, eventKindLabel, isTitle, isRunnerUp, listedInTournaments } from "./event.ts";

test("행사 목록과 우승은 종류로 판정하고 CK를 대회로 세지 않는다", () => {
  assert.equal(eventKindLabel("ck"), "CK");
  assert.equal(listedInTournaments("ck"), false);
  assert.equal(isTitle({ kind: "tournament", placement_rank: 1 }), true);
  assert.equal(isTitle({ kind: "ck", placement_rank: 1 }), false);
  assert.equal(isRunnerUp({ kind: "tournament", placement_rank: 2 }), true);
});
test("참가 단계는 개별 팀의 근거로만 판정한다", () => {
  assert.equal(classifyTeamStage({ rank: null, placement: null }), "unknown");
  assert.equal(classifyTeamStage({ rank: null, placement: "1차 예선 탈락" }), "qualifiers");
  assert.equal(classifyTeamStage({ rank: 4, placement: "4강" }), "finals");
  assert.equal(classifyTeamStage({ rank: null, placement: null, inFinals: true }), "finals");
  assert.equal(classifyTeamStage({ rank: 99, placement: "예선 탈락", inFinals: true }), "unknown");
});

test("순위 숫자가 없어도 명확한 성적 문구는 본선 근거다", () => {
  for (const placement of ["우승", "준우승", "공동3위", "4강", "8강 탈락", "5–6위"]) {
    assert.equal(classifyTeamStage({ rank: null, placement }), "finals", placement);
  }
  assert.equal(classifyTeamStage({ rank: null, placement: "탈락" }), "unknown");
  assert.equal(classifyTeamStage({ rank: null, placement: "예선 4강 탈락" }), "qualifiers");
});

test("순위 숫자와 성적 문구의 본선·예선 근거가 충돌하면 미확인이다", () => {
  assert.equal(classifyTeamStage({ rank: 99, placement: "우승" }), "unknown");
  assert.equal(classifyTeamStage({ rank: 1, placement: "예선 탈락" }), "unknown");
});
