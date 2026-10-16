import test from "node:test";
import assert from "node:assert/strict";
import { recordCursor, readRecordCursor } from "./record-cursor.ts";

test("날짜와 묶음 ID는 이어 보기 주소에서 그대로 복원된다", () => {
  const at = "2026-10-13T14:59:59.123Z", id = "vod:2026-10-13.series-1";
  assert.deepEqual(readRecordCursor(recordCursor(at, id)), { at, id });
});

test("JS가 자동 보정하는 잘못된 날짜를 DB 커서로 넘기지 않는다", () => {
  for (const at of ["2026-02-30T00:00:00.000Z", "2026-10-13T24:00:00.000Z", "2026-13-01T00:00:00.000Z", "not-a-date"]) {
    assert.equal(readRecordCursor(`${at}|sample`), null, at);
  }
  assert.equal(readRecordCursor("2026-10-13T00:00:00.000Z|"), null);
  assert.equal(readRecordCursor("2026-10-13T00:00:00.000Z|bad/id"), null);
});
