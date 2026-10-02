/** 편성표 전체의 휠을 날짜 축으로 보낸다. 패널과 확대 제스처는 건드리지 않는다. */
export function bindTimelineWheel(frame: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    const target = event.target as Element | null;
    if (event.ctrlKey || target?.closest?.(".sched-panel")) return;
    // 서버 컴포넌트가 도착하거나 갱신되어도 현재 스크롤 요소를 찾는다.
    const chart = frame.querySelector<HTMLElement>(".sched-scroll");
    if (!chart || chart.scrollWidth <= chart.clientWidth) return;
    const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!raw) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chart.clientWidth : 1;
    event.preventDefault();
    chart.scrollLeft = Math.max(0, Math.min(chart.scrollWidth - chart.clientWidth, chart.scrollLeft + raw * unit));
  };
  frame.addEventListener("wheel", onWheel, { passive: false });
  return () => frame.removeEventListener("wheel", onWheel);
}

/** 소수점 스크롤 위치도 끝으로 인식한다. 넘침이 없으면 양쪽 확장을 제공한다. */
export function timelineEdges(scrollLeft: number, scrollWidth: number, clientWidth: number) {
  return { left: scrollLeft <= 1, right: scrollLeft >= Math.max(0, scrollWidth - clientWidth) - 1 };
}
