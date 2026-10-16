import assert from "node:assert/strict";
import { test } from "node:test";
import { CAM_ID_LENGTH, DEFAULT_OPTIONS, inviteText, isCamId, newCamId, startLink, watchLink } from "./links.ts";

const ROOM = "room9xyz";
const minsu = { id: "seataaaa", name: "민수" };
const chulsu = { id: "seatbbbb", name: "철수" };
const younghee = { id: "seatcccc", name: "영희" };
const seats = [minsu, chulsu, younghee];

test("캠 합방: 시작은 방에 내 캠을 보내고, 보기는 나를 뺀 명단만 한 화면에", () => {
  assert.equal(startLink(ROOM, minsu, DEFAULT_OPTIONS), "https://vdo.ninja/?push=seataaaa&room=room9xyz&webcam&quality=1080");
  assert.equal(watchLink(ROOM, minsu, seats, DEFAULT_OPTIONS), "https://vdo.ninja/?scene&room=room9xyz&view=seatbbbb,seatcccc&clean&buffer=0&noaudio");
  assert.equal(new URL(watchLink(ROOM, chulsu, seats, DEFAULT_OPTIONS)).searchParams.get("view"), "seataaaa,seatcccc");
});

test("캠 합방: 소리는 기본으로 끈다 — 목소리는 보통 디스코드로 한다", () => {
  assert.equal(DEFAULT_OPTIONS.audio, false);
});

test("캠 합방: 이름을 고쳐도 링크가 그대로다 — 방송 도구에 넣은 보기 창을 다시 안 넣는다", () => {
  const renamed = seats.map((s) => ({ ...s, name: "다른 이름" }));
  assert.equal(startLink(ROOM, renamed[0], DEFAULT_OPTIONS), startLink(ROOM, minsu, DEFAULT_OPTIONS));
  assert.equal(watchLink(ROOM, renamed[0], renamed, DEFAULT_OPTIONS), watchLink(ROOM, minsu, seats, DEFAULT_OPTIONS));
});

test("캠 합방: 명단 고정 — 참가자를 추가하면 기존 사람의 보기 링크가 바뀐다(다시 보내야 한다)", () => {
  const more = [...seats, { id: "seatdddd", name: "추가 멤버" }];
  assert.notEqual(watchLink(ROOM, minsu, more, DEFAULT_OPTIONS), watchLink(ROOM, minsu, seats, DEFAULT_OPTIONS));
  assert.equal(startLink(ROOM, minsu, DEFAULT_OPTIONS), startLink(ROOM, minsu, DEFAULT_OPTIONS));
});

test("캠 합방: 화질은 시작 링크에만, 소리·지연은 보기 링크에만 반영된다", () => {
  const o = { quality: "1080" as const, audio: true, lowLatency: false };
  assert.equal(startLink(ROOM, minsu, o), "https://vdo.ninja/?push=seataaaa&room=room9xyz&webcam&quality=1080");
  assert.equal(watchLink(ROOM, minsu, seats, o), "https://vdo.ninja/?scene&room=room9xyz&view=seatbbbb,seatcccc&clean");
});

test("캠 합방: 초대 문구 — 사람마다 자기 이름 아래 링크 두 개, 노출 주의 한 줄", () => {
  const text = inviteText(ROOM, seats, DEFAULT_OPTIONS);
  assert.match(text, /■ 민수\n내 캠 켜기: https:\/\/vdo\.ninja\/\?push=seataaaa&room=room9xyz.*\n다른 사람 캠 보기: https:\/\/vdo\.ninja\/\?scene&room=room9xyz&view=seatbbbb,seatcccc/);
  assert.match(text, /■ 철수\n내 캠 켜기: https:\/\/vdo\.ninja\/\?push=seatbbbb/);
  assert.match(text, /주소창/);
});

test("캠 합방: 새 이름표는 정해진 길이이고 헷갈리는 글자가 없다", () => {
  for (let i = 0; i < 200; i++) {
    const id = newCamId();
    assert.equal(id.length, CAM_ID_LENGTH);
    assert.ok(isCamId(id));
    assert.doesNotMatch(id, /[lo01]/);
  }
});

test("빈 이름과 공백만 입력한 칸은 초대와 보기 대상에서 제외한다", () => {
  const blanks = [{ id: "emptyone", name: "" }, { id: "emptytwo", name: "   " }];
  const all = [minsu, ...blanks, younghee];
  const text = inviteText(ROOM, all, DEFAULT_OPTIONS);
  assert.equal(text, inviteText(ROOM, [minsu, younghee], DEFAULT_OPTIONS));
  assert.equal(new URL(watchLink(ROOM, minsu, all, DEFAULT_OPTIONS)).searchParams.get("view"), younghee.id);
  assert.equal(inviteText(ROOM, blanks, DEFAULT_OPTIONS), "");
  assert.equal(inviteText(ROOM, [...all, { id: "moreblank", name: "" }], DEFAULT_OPTIONS), text);
});

test("한 명만 입력해도 본인 링크를 만들고 빈 보기 대상은 전체 방으로 확장하지 않는다", () => {
  const text = inviteText(ROOM, [minsu], DEFAULT_OPTIONS);
  assert.match(text, /■ 민수/);
  assert.equal(new URL(watchLink(ROOM, minsu, [minsu], DEFAULT_OPTIONS)).searchParams.get("view"), `empty-${ROOM}`);
});
