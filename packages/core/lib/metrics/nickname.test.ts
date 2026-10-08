import { test } from "node:test";
import assert from "node:assert/strict";

import { checkNickname, nicknameKey } from "./nickname.ts";

const streamers = new Set(["이상호", "김민교", "phonics"].map(nicknameKey));
const error = (raw: string) => {
  const r = checkNickname(raw, streamers);
  return r.ok ? null : r.error;
};

test("정규화 키는 공백·기호·전각·대소문자를 지운다", () => {
  assert.equal(nicknameKey(" 철 수! "), "철수");
  assert.equal(nicknameKey("ＣＨＵＬＳＵ"), "chulsu");
  assert.equal(nicknameKey("Chul-Su_2"), "chulsu2");
});

test("길이는 2~12자(코드포인트 기준), 앞뒤 공백은 지우고 안쪽 공백은 하나로", () => {
  assert.match(error("철")!, /2~12자/);
  assert.match(error("가나다라마바사아자차카타파")!, /2~12자/);
  const ok = checkNickname("  철수   영희  ", streamers);
  assert.deepEqual(ok, { ok: true, nickname: "철수 영희", key: "철수영희" });
});

test("글자·숫자가 두 개 미만이면 거부한다", () => {
  assert.match(error("!!!")!, /두 개 이상/);
  assert.match(error("a!")!, /두 개 이상/);
});

test("제어 문자는 거부한다", () => {
  assert.match(error("철\u0000수")!, /쓸 수 없는 문자/);
});

test("운영진으로 보이는 이름은 거부한다 — 한글은 포함만 해도, 영문은 일치만", () => {
  assert.match(error("운영자")!, /운영진/);
  assert.match(error("공식 운영자")!, /운영진/);
  assert.match(error("ADMIN")!, /운영진/);
  assert.match(error("탈퇴한 회원")!, /운영진/);
  assert.equal(error("badminton"), null);
});

test("★ 등록 스트리머 이름·별칭과 정규화 키가 같으면 거부한다(사칭)", () => {
  assert.match(error("이상호")!, /스트리머/);
  assert.match(error("이 상 호")!, /스트리머/);
  assert.match(error("PHONICS")!, /스트리머/);
  assert.equal(error("이상호팬"), null);
});
