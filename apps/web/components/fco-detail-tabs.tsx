"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * 경기 상세 아래쪽 탭 — 지표 비교 / 슛 / 패스 / 스쿼드.
 * 스코어보드와 경기 흐름은 탭 밖에 고정이고, 여기부터는 한 번에 한 카드만 보여 스크롤을 줄인다.
 *
 * 네 카드는 모두 그려 두고 보이는 것만 바꾼다(hidden). 탭을 오가도 슛 카드의 "전체/팀별" 같은
 * 카드 안 선택이 초기화되지 않는다. 고른 탭은 주소 해시(#shots 등)에 남겨 공유·새로고침해도 그 탭으로 열린다.
 */
export interface DetailTab { key: string; label: string; content: ReactNode }

export function FcoDetailTabs({ tabs }: { tabs: DetailTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");

  // 서버 렌더와 첫 화면을 맞추려고 해시는 마운트 뒤에 읽는다.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (tabs.some((tab) => tab.key === fromHash)) setActive(fromHash);
  }, [tabs]);

  const select = (key: string) => {
    setActive(key);
    // replaceState — 해시로 페이지가 튀지 않고 뒤로 가기 기록도 쌓지 않는다
    window.history.replaceState(null, "", `#${key}`);
  };

  return <section className="fc-detail">
    <div className="fc-detail-tabs" role="tablist" aria-label="경기 상세">
      {tabs.map((tab) => <button key={tab.key} type="button" role="tab"
        id={`fc-detail-tab-${tab.key}`} aria-controls={`fc-detail-panel-${tab.key}`}
        aria-selected={active === tab.key} className="fc-detail-tab" onClick={() => select(tab.key)}>
        {tab.label}
      </button>)}
    </div>
    {tabs.map((tab) => <div key={tab.key} id={`fc-detail-panel-${tab.key}`} role="tabpanel"
      aria-labelledby={`fc-detail-tab-${tab.key}`} hidden={active !== tab.key} className="fc-card fc-detail-panel">
      {tab.content}
    </div>)}
  </section>;
}
