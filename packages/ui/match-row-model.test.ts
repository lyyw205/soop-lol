import { test } from "node:test";
import assert from "node:assert/strict";

import { bestOfLabel, formatBadge, isRepeatedDate, matchOutcome, OUTCOME_LABEL, setCountLabel } from "./match-row-model.ts";

test("다전제 승패는 세트 과반으로 정한다", () => {
  assert.equal(matchOutcome(2, 3), "win", "2:1 은 승");
  assert.equal(matchOutcome(1, 3), "loss", "1:2 는 패");
  assert.equal(matchOutcome(2, 2), "win", "2:0 은 승");
  assert.equal(matchOutcome(1, 1), "win", "단판 승");
  assert.equal(matchOutcome(0, 1), "loss", "단판 패");
});

test("★ 세트가 정확히 반이면 무승부다 — 옛 2세트제 조별리그가 그렇다", () => {
  assert.equal(matchOutcome(1, 2), "draw");
  assert.equal(OUTCOME_LABEL[matchOutcome(1, 2)], "무");
  // "이긴 세트가 더 많지 않으면 패" 로 단순화하면 이 판이 패로 세어진다.
  assert.notEqual(matchOutcome(1, 2), "loss");
});

test("BO 라벨은 몇 판 몇 선승인가만 말한다 (세트 수가 아니다)", () => {
  assert.equal(bestOfLabel(3), "BO3");
  assert.equal(bestOfLabel(5), "BO5");
});

test("★ best_of=1 은 BO1 이 아니라 단판이다", () => {
  // 멸망전 시드의 단판 시리즈가 305건이다. 공식(2×승수−1)이 전부 1 을 내므로
  // 그대로 두면 화면이 온통 `BO1` 이 된다. 한국어로 그렇게 쓰는 사람은 없다.
  assert.equal(bestOfLabel(1), "단판");
  // 규정상 한 판(best_of=1)과 시리즈 없는 단독 경기는 같은 글자다.
  // ★ 시리즈에서 한 판만 모은 경우는 다르다 — Bo3 의 첫 판일 수 있으니 단판이라 부르지 않는다(0035).
  assert.equal(bestOfLabel(1), setCountLabel(1, true));
  assert.notEqual(bestOfLabel(1), setCountLabel(1, false));
});

test("★ 형식을 모르면 빈 문자열이다 — 요소를 지우면 그리드 칸이 밀린다", () => {
  // 실제로 겪은 사고: `{best_of && <small>}` 로 조건부 렌더했더니 자식이 4→5 로 오락가락해
  // 승패가 다음 줄로 떨어졌다. 칸은 두고 내용만 비우라는 뜻으로 빈 문자열을 준다.
  assert.equal(bestOfLabel(null), "");
  assert.equal(bestOfLabel(undefined), "");
  assert.equal(bestOfLabel(0), "");
});

test("형식이 없으면 세트 수로 대신한다 — 둘을 같이 보여주지 않는다", () => {
  assert.equal(setCountLabel(1, true), "단판");
  assert.equal(setCountLabel(3, false), "3세트");
  assert.equal(formatBadge(3, 2, false), "BO3", "형식을 알면 형식이 이긴다");
  assert.equal(formatBadge(null, 3, false), "3세트");
  assert.equal(formatBadge(null, 1, true), "단판");
  assert.equal(formatBadge(null, 1, false), "1세트", "시리즈의 한 판만 모았으면 단판이 아니다");
});

test("★ 형식을 몰라도 칸은 절대 비지 않는다 — 세 화면이 같은 글자를 낸다", () => {
  // 공식이 안 통하는 유일한 케이스: 2세트 1:1 무승부(옛 조별리그 12건). best_of 는 NULL 이다.
  // "단판" 이라 쓰면 거짓말이고(2세트를 뛰었다), 비우면 미상인지 버그인지 모른다.
  assert.equal(formatBadge(null, 2, false), "2세트");
  for (const [bestOf, sets] of [[3, 3], [5, 4], [1, 1], [null, 2], [null, 1]] as const) {
    assert.notEqual(formatBadge(bestOf, sets, sets === 1), "", `best_of=${bestOf} sets=${sets} 에서 칸이 비었다`);
  }
});

test("★ 같은 날이 이어지면 날짜는 맨 위 한 번만 쓴다", () => {
  assert.equal(isRepeatedDate("2026.09.19", "2026.09.19"), true);
  assert.equal(isRepeatedDate("2026.09.19", "2026.09.20"), false);
  assert.equal(isRepeatedDate("2026.09.19", ""), false, "첫 줄은 언제나 쓴다");
  // 연도 머리글이 끼면 흐름이 끊기므로 같은 날이어도 다시 쓴다.
  assert.equal(isRepeatedDate("2026.09.19", "2026.09.19", true), false);
});
