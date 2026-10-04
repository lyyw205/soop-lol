"use client";

import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";

type Tab = { id: string; label: string; href: string; count?: number };

/** URL에 선택을 남겨 필터 변경·새로고침·뒤로 가기에서도 같은 패널을 연다. */
export function ChallengeTabs({ tabs, active }: { tabs: Tab[]; active: string }) {
  const router = useRouter();
  const select = (tab: Tab) => router.push(tab.href, { scroll: false });
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next == null) return;
    event.preventDefault();
    document.getElementById(`sc-tab-${tabs[next].id}`)?.focus({ preventScroll: true });
    select(tabs[next]);
  };

  return (
    <nav className="sc-section-nav" role="tablist" aria-label="도전 기록 탐색">
      {tabs.map((tab, index) => (
        <button key={tab.id} id={`sc-tab-${tab.id}`} type="button" role="tab"
          aria-selected={active === tab.id} aria-controls={`sc-panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => select(tab)} onKeyDown={(event) => onKeyDown(event, index)}>
          {tab.label}{tab.count != null && <span>{tab.count}</span>}
        </button>
      ))}
    </nav>
  );
}
