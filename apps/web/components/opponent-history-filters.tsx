"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { recordPeriodLabel, type RecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import type { OpponentSort } from "@soop-lol/core/lib/metrics/opponents";

/**
 * 상대 전적의 머리글 한 줄 — **제목 · 요약 · 조작**이 같은 줄에 선다.
 *
 * ★ 요약에서 '상대/맞라인' 을 뺐다. 바로 오른쪽 토글이 그걸 말하고 있고, 탭 이름에도
 *   '상대 전적' 이 있어서 같은 말이 한 화면에 세 번 나왔다.
 */
export function OpponentHistoryHeading({href, period, laneOnly, categoryLabel, count, sort, laneToggle, scopeLabel}: {
  href: string; period: RecordPeriod; laneOnly: boolean; categoryLabel?: string; count: number; sort: OpponentSort;
  laneToggle?: ReactNode; scopeLabel?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const summary = [scopeLabel ?? recordPeriodLabel(period), categoryLabel, `상대 ${count}명`].filter(Boolean).join(" · ");
  return <div className="opponent-results-heading" aria-busy={pending}>
    <h3><strong>상대 전적</strong><span>{summary}</span></h3>
    {/* 토글과 정렬은 한 덩어리로 묶는다 — 따로 두면 좁은 화면에서 한쪽만 아랫줄로 떨어진다. */}
    <div className="opponent-results-actions">
    {laneToggle}
    <select aria-label="상대 전적 정렬" value={sort} disabled={pending} onChange={(e)=>{
      const [path, query] = href.split("?");
      const params = new URLSearchParams(query);
      params.set("sort",e.currentTarget.value);params.set("tab","opponents");params.delete("page");
      startTransition(()=>router.push(`${path}?${params}`,{scroll:false}));
    }}>
      <option value="games">경기 많은 순</option><option value="recent">최신순</option><option value="winrate">승률 높은순</option><option value="winrate_asc">승률 낮은순</option>
    </select>
    </div>
  </div>;
}
