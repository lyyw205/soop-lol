"use client";
import { useState, type ReactNode } from "react";

type SortKey = "rank" | "value" | "officialRank" | "rating" | "previousBest";
export interface RankingItem {
  id: string;
  rank: number | null;
  value: number | null;
  officialRank: number | null;
  rating: number | null;
  previousBest: number | null;
  content: ReactNode;
}
const columns: { label: string; key?: SortKey; left?: boolean; title?: string }[] = [
  { label: "순위", key: "rank" },
  { label: "공식 순위", key: "officialRank", title: "넥슨 구단가치 TOP 50 순위" },
  { label: "스트리머", left: true },
  { label: "구단주명", left: true }, { label: "팀컬러" },
  { label: "구단가치", key: "value", left: true }, { label: "7일 등락" },
  { label: "공식경기", key: "rating", title: "현재 시즌 1대1 공식경기 등급" },
  { label: "이전 최고등급", key: "previousBest", title: "직전 시즌 1대1 공식경기 최고등급" },
];

export function RankingTable({ items }: { items: RankingItem[] }) {
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: "rank", ascending: true });
  const sorted = [...items].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    return (av - bv) * (sort.ascending ? 1 : -1);
  });
  return <>
    <div className="cv-streamer-list" tabIndex={0} aria-label="스트리머 선택">
    <div className="cv-streamer-columns">
      {columns.map(column => <span key={column.label} className={column.left ? "cv-align-left" : undefined}>
        {column.key ? <button type="button" className="cv-sort" data-active={sort.key === column.key}
          title={column.title} aria-label={`${column.label} 정렬${sort.key === column.key ? ` · 현재 ${sort.ascending ? "오름차순" : "내림차순"}` : ""}`}
          onClick={() => setSort({ key: column.key!, ascending: sort.key === column.key ? !sort.ascending : column.key === "rank" || column.key === "officialRank" })}>
          {column.label}<span aria-hidden="true">{sort.key === column.key ? sort.ascending ? "↑" : "↓" : "↕"}</span>
        </button> : column.label}
      </span>)}
    </div>
      {sorted.map(row => <div key={row.id}>{row.content}</div>)}
      {!items.length && <div className="fc-empty">연결된 FC 온라인 스트리머가 없습니다.</div>}
    </div>
    <span className="cv-sr-only" aria-live="polite">{columns.find(c => c.key === sort.key)?.label} {sort.ascending ? "오름차순" : "내림차순"}</span>
  </>;
}
