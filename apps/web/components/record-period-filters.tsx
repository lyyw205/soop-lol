"use client";

/**
 * 주소(`?period=` / `?from=` / `?to=`)에 기간을 남기는 필터와, 상대 전적의 상대/맞라인 토글.
 *
 * ★ 날짜 칸 자체는 `packages/ui/record-date-range` 다
 *   상대전적 화면(모듈)도 같은 칸을 쓰는데, 거기는 기간을 주소가 아니라 컴포넌트 상태로
 *   들고 있다. 그래서 칸은 "이 범위로 정했다" 만 알리고, **어디에 적을지는 여기가 정한다.**
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import { RecordDateRange } from "../../../packages/ui/record-date-range";

/** 주소에 기간을 적는 판. 탭을 옮겨도 살아 있고 링크로 공유된다. */
export function RecordPeriodFilters({ href, period, label = "기간" }: {
  href: string; period: RecordPeriod; label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <RecordDateRange period={period} label={label} disabled={pending} onApply={(range) => {
    const [path, query] = href.split("?");
    const params = new URLSearchParams(query);
    // 기간을 바꾸면 연도·기존 기간은 전부 지운다 — 둘이 겹치면 어느 쪽이 먹었는지 모른다.
    for (const key of ["year", "period", "from", "to", "page"]) params.delete(key);
    if (range) { params.set("period", "custom"); params.set("from", range.from); params.set("to", range.to); }
    startTransition(() => router.push(`${path}?${params}`, { scroll: false }));
  }} />;
}

/** 상대 전적의 상대/맞라인 토글. 기간은 상단 줄이 맡으므로 여기 다시 그리지 않는다. */
export function OpponentModeToggle({ href, laneOnly }: { href: string; laneOnly: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function go(lane: boolean) {
    const [path, query] = href.split("?");
    const params = new URLSearchParams(query);
    if (lane) params.set("duel", "lane"); else params.delete("duel");
    params.set("tab", "opponents");
    params.delete("page");
    startTransition(() => router.push(`${path}?${params}`, { scroll: false }));
  }
  return <div className="opponent-mode" aria-label="상대 전적 구분" aria-busy={pending}>
    <button type="button" aria-pressed={!laneOnly} disabled={pending} onClick={() => go(false)}>상대</button>
    <button type="button" aria-pressed={laneOnly} disabled={pending} onClick={() => go(true)}>맞라인</button>
  </div>;
}
