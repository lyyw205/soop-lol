import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OPTIONS } from "./links.ts";
import { newRoom, parseRoom } from "./rooms.ts";

test("지난 방: 새 방은 네 자리, 이름표가 모두 다르다", () => {
  const r = newRoom();
  assert.equal(r.seats.length, 4);
  assert.equal(new Set([r.room, ...r.seats.map((s) => s.id)]).size, 5);
});

test("지난 방: 저장한 방을 그대로 되살린다 — 마지막으로 보낸 초대 문구까지", () => {
  const r = { ...newRoom(), sent: "[캠 합방] …" };
  r.seats[0].name = "민수";
  r.options.audio = true;
  assert.deepEqual(parseRoom(JSON.stringify(r)), r);
});

test("지난 방: 저장된 값을 믿지 않는다 — 깨진 글자·이상한 모양은 새 방으로", () => {
  assert.equal(parseRoom("{깨짐"), null);
  assert.equal(parseRoom(null), null);
  assert.equal(parseRoom(JSON.stringify({ room: "BAD ID", seats: [] })), null);
  // 자리가 둘 미만으로 줄면 방이 안 된다
  assert.equal(parseRoom(JSON.stringify({ room: "roomok12", seats: [{ id: "seatok12" }, { id: "<script>" }] })), null);
  const r = parseRoom(JSON.stringify({ room: "roomok12", seats: [{ id: "seatok12", name: 3 }, { id: "seatok34", name: "철수" }], options: { quality: "4k", audio: "yes" } }));
  assert.equal(r!.seats.length, 4);
  assert.deepEqual({ ...r, seats: r!.seats.slice(0, 2) }, { room: "roomok12", seats: [{ id: "seatok12", name: "" }, { id: "seatok34", name: "철수" }], options: DEFAULT_OPTIONS });
});

test("지난 방: 8명을 넘는 명단과 긴 초대 문구도 그대로 되살린다", () => {
  const seats = Array.from({ length: 30 }, (_, i) => ({ id: `seatxx${i}`, name: "" }));
  const room = { ...newRoom(), seats, sent: "가".repeat(10000) };
  assert.deepEqual(parseRoom(JSON.stringify(room)), room);
});
