/**
 * 마이그레이션 지문 검사.
 *
 * 이 지문 하나로 "저장소의 SQL 과 DB 의 실제 스키마가 갈라졌나" 를 판정한다.
 * 여기가 헐거우면 갈라진 걸 못 잡거나(내용이 바뀌었는데 같은 지문),
 * 멀쩡한 저장소를 막는다(줄바꿈만 달라도 다른 지문).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { checksumOf } from "./migrations.ts";

test("같은 내용은 같은 지문", () => {
  assert.equal(checksumOf("ALTER TABLE x ADD COLUMN y text;"), checksumOf("ALTER TABLE x ADD COLUMN y text;"));
});

test("한 글자만 달라도 다른 지문 — 이게 갈라짐을 잡는 근거다", () => {
  assert.notEqual(checksumOf("ADD COLUMN y text;"), checksumOf("ADD COLUMN z text;"));
});

test("주석만 붙어도 잡는다 — DDL 인지 주석인지 기계는 모른다", () => {
  const base = "CREATE INDEX i ON t (c);";
  assert.notEqual(checksumOf(base), checksumOf(`${base}\n-- 설명 한 줄`));
});

test("CRLF 는 같은 것으로 본다 — 저장소가 공개라 Windows 체크아웃이 있다", () => {
  // 이걸 normalize 안 하면 Windows 에서 받은 사람은 **전 마이그레이션이 바뀐 것**으로
  // 보여 아무것도 못 돌린다. 검사가 아니라 방해물이 된다.
  assert.equal(checksumOf("a\r\nb\r\nc"), checksumOf("a\nb\nc"));
});

test("공백·대소문자는 그대로 본다 — SQL 은 의미가 바뀔 수 있다", () => {
  assert.notEqual(checksumOf("select 1"), checksumOf("SELECT 1"));
  assert.notEqual(checksumOf("a b"), checksumOf("a  b"));
});

test("지문은 짧고 로그에 붙일 만하다", () => {
  const c = checksumOf("x");
  assert.equal(c.length, 16);
  assert.match(c, /^[0-9a-f]+$/);
});
