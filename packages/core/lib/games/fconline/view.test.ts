import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeGoalTime,
  FCO_SHOOT_TYPE_LABEL,
  fcoMatchEndLabel,
  fcoPlayerPid,
  GOAL_PHASE_LABEL,
  isVoltaMode,
} from "./view.ts";

// goalTime 값은 전부 실제 match-detail 응답에서 꺼냈다. 눈대중이 아니라 API 가 준 숫자로 고정한다.

test("decodeGoalTime: 전반은 값이 그대로 초다", () => {
  assert.deepEqual(decodeGoalTime(321), { phase: 0, seconds: 321, label: "5'" });
});

test("decodeGoalTime: 후반은 2^24 를 빼고 45분을 더한다", () => {
  // 16777415 = 2^24 + 199 → 45:00 + 3:19 = 48분 19초
  assert.deepEqual(decodeGoalTime(16777415), { phase: 1, seconds: 2899, label: "48'" });
});

test("decodeGoalTime: 연장 후반은 2^24*3 을 빼고 105분을 더한다", () => {
  // 50332222 = 2^24*3 + 574 → 105:00 + 9:34 = 114분 34초
  assert.deepEqual(decodeGoalTime(50332222), { phase: 3, seconds: 6874, label: "114'" });
});

test("decodeGoalTime: 구간이 라벨 범위를 넘지 않는다", () => {
  assert.equal(decodeGoalTime((1 << 24) * 9)?.phase, GOAL_PHASE_LABEL.length - 1);
});

test("decodeGoalTime: 숫자가 아니거나 음수면 null 이다", () => {
  for (const bad of [null, undefined, "786", -1, Number.NaN]) {
    assert.equal(decodeGoalTime(bad), null);
  }
});

test("isVoltaMode: 200 이상만 볼타 등급표를 쓴다", () => {
  for (const mode of ["204", "214", "224", "234"]) assert.equal(isVoltaMode(mode), true);
  // 50 공식경기·52 감독모드·60 공식 친선은 전부 division.json 이다.
  for (const mode of ["30", "40", "50", "52", "60"]) assert.equal(isVoltaMode(mode), false);
  for (const mode of [null, undefined, ""]) assert.equal(isVoltaMode(mode), false);
});

test("fcoMatchEndLabel: 정상 종료는 표시하지 않고 몰수는 승패를 구분한다", () => {
  assert.equal(fcoMatchEndLabel(0), null);
  assert.equal(fcoMatchEndLabel(null), null);
  assert.equal(fcoMatchEndLabel(1), "몰수승");
  assert.equal(fcoMatchEndLabel(2), "몰수패");
});

test("fcoPlayerPid: spid 앞 3자리 시즌을 떼고 선수 번호만 남긴다", () => {
  assert.equal(fcoPlayerPid(877020801), 20801); // 크리스티아누 호날두
  assert.equal(fcoPlayerPid(868037576), 37576); // 호나우두
  assert.equal(fcoPlayerPid(null), 0);
});

test("FCO_SHOOT_TYPE_LABEL: 문서 밖 13 은 추정임을 밝히고, 근거 없는 14 는 이름을 짓지 않는다", () => {
  assert.equal(FCO_SHOOT_TYPE_LABEL[13], "레이저 슈터(추정)");
  assert.equal(FCO_SHOOT_TYPE_LABEL[14], undefined);
});
