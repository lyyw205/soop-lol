import assert from "node:assert/strict";
import { test } from "node:test";
import { bindTimelineWheel, timelineEdges } from "./scroll.ts";

function fixture() {
  const chart = { scrollLeft: 0, scrollWidth: 1600, clientWidth: 800 };
  const frame = Object.assign(new EventTarget(), { querySelector: () => chart });
  const dispose = bindTimelineWheel(frame as unknown as HTMLElement);
  function wheel(deltaY: number, options: { deltaX?: number; deltaMode?: number; ctrlKey?: boolean; panel?: boolean } = {}) {
    const event = new Event("wheel", { cancelable: true });
    Object.assign(event, { deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, ...options });
    Object.defineProperty(event, "target", { value: { closest: () => options.panel ? {} : null } });
    frame.dispatchEvent(event);
    return event;
  }
  return { chart, wheel, dispose };
}

test("제목·범례를 포함한 프레임의 세로 휠을 가로 이동으로 전환", () => {
  const { chart, wheel, dispose } = fixture();
  assert.equal(wheel(120).defaultPrevented, true);
  assert.equal(chart.scrollLeft, 120);
  wheel(-40);
  assert.equal(chart.scrollLeft, 80);
  dispose();
  assert.equal(wheel(120).defaultPrevented, false);
  assert.equal(chart.scrollLeft, 80);
});
test("양 끝에서도 페이지로 스크롤을 넘기지 않음", () => {
  const { chart, wheel } = fixture();
  assert.equal(wheel(-120).defaultPrevented, true);
  assert.equal(chart.scrollLeft, 0);
  wheel(2000);
  assert.equal(chart.scrollLeft, 800);
  assert.equal(wheel(120).defaultPrevented, true);
  assert.equal(chart.scrollLeft, 800);
});
test("패널의 세로 스크롤과 확대 제스처는 유지", () => {
  const { chart, wheel } = fixture();
  assert.equal(wheel(120, { panel: true }).defaultPrevented, false);
  assert.equal(wheel(120, { ctrlKey: true }).defaultPrevented, false);
  assert.equal(chart.scrollLeft, 0);
});
test("트랙패드 가로 입력 및 줄·페이지 단위 휠 지원", () => {
  const { chart, wheel } = fixture();
  wheel(0, { deltaX: 60 });
  assert.equal(chart.scrollLeft, 60);
  wheel(3, { deltaMode: 1 });
  assert.equal(chart.scrollLeft, 108);
  wheel(1, { deltaMode: 2 });
  assert.equal(chart.scrollLeft, 800);
});
test("가로 넘침이 없으면 페이지 스크롤 유지", () => {
  const { chart, wheel } = fixture();
  chart.scrollWidth = chart.clientWidth;
  assert.equal(wheel(120).defaultPrevented, false);
});


test("확장 버튼 — 시작·중간·끝과 소수점 위치를 구분", () => {
  assert.deepEqual(timelineEdges(0, 2240, 1000), { left: true, right: false });
  assert.deepEqual(timelineEdges(500, 2240, 1000), { left: false, right: false });
  assert.deepEqual(timelineEdges(1239.5, 2240, 1000), { left: false, right: true });
  assert.deepEqual(timelineEdges(0, 800, 800), { left: true, right: true });
  assert.deepEqual(timelineEdges(480, 2720, 1000), { left: false, right: false }, "왼쪽 3일 추가 후 기존 위치에 있으면 버튼이 사라진다");
});
