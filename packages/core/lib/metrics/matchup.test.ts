import { test } from "node:test";
import assert from "node:assert/strict";

import { isLaneMatchup, kda, laneStats, resolvePosition, totalCs } from "./matchup.ts";
import type { ParticipantDto } from "../riot/types.ts";

const mid = { teamId: 100, teamPosition: "MIDDLE", individualPosition: "MIDDLE" };
const enemyMid = { teamId: 200, teamPosition: "MIDDLE", individualPosition: "MIDDLE" };

test("resolvePosition — 두 필드가 일치할 때만 확정한다", () => {
  assert.equal(resolvePosition(mid), "MIDDLE");
  // 스왑 라인: 추론이 갈렸다 → 판정 포기
  assert.equal(resolvePosition({ teamPosition: "TOP", individualPosition: "MIDDLE" }), null);
  assert.equal(resolvePosition({ teamPosition: "", individualPosition: "MIDDLE" }), null);
  assert.equal(resolvePosition({ teamPosition: "Invalid", individualPosition: "Invalid" }), null);
});

test("resolvePosition — individualPosition 이 비면 teamPosition 만으로 인정한다", () => {
  assert.equal(resolvePosition({ teamPosition: "JUNGLE", individualPosition: "" }), "JUNGLE");
  assert.equal(resolvePosition({ teamPosition: "JUNGLE" }), "JUNGLE");
});

test("isLaneMatchup — 반대 팀 + 같은 포지션", () => {
  assert.equal(isLaneMatchup(mid, enemyMid), true);
});

test("isLaneMatchup — 같은 팀이면 맞라인이 아니다", () => {
  assert.equal(isLaneMatchup(mid, { ...enemyMid, teamId: 100 }), false);
});

test("isLaneMatchup — 포지션이 다르면 아니다", () => {
  assert.equal(
    isLaneMatchup(mid, { teamId: 200, teamPosition: "TOP", individualPosition: "TOP" }),
    false,
  );
});

test("isLaneMatchup — 한쪽이라도 포지션이 불확실하면 아니다", () => {
  assert.equal(
    isLaneMatchup(mid, { teamId: 200, teamPosition: "MIDDLE", individualPosition: "TOP" }),
    false,
  );
});

test("totalCs — 미니언 + 정글몹", () => {
  assert.equal(totalCs({ totalMinionsKilled: 180, neutralMinionsKilled: 20 } as ParticipantDto), 200);
  assert.equal(totalCs({} as ParticipantDto), 0);
});

test("laneStats — challenges 가 없어도 터지지 않는다", () => {
  assert.deepEqual(laneStats({} as ParticipantDto), {
    soloKills: undefined,
    csAt10: undefined,
    maxLevelLeadOverOpponent: undefined,
    killParticipation: undefined,
    teamDamagePercentage: undefined,
  });
});

test("laneStats — 숫자가 아닌 값은 버린다", () => {
  const p = { challenges: { soloKills: 2, csAt10: "많음" } } as unknown as ParticipantDto;
  assert.equal(laneStats(p).soloKills, 2);
  assert.equal(laneStats(p).csAt10, undefined);
});

test("kda — 데스 0 은 나누지 않는다", () => {
  assert.equal(kda(5, 0, 5), 10);
  assert.equal(kda(4, 2, 6), 5);
});
