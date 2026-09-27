import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

/** 게임별 지표는 슬롯으로 두고 전적 화면의 배치만 공유한다. */
export function RecordOverviewCard({ children, label, className = "", dataArt, style, ariaLive }: {
  children: ReactNode; label: string; className?: string; dataArt?: string; style?: CSSProperties;
  ariaLive?: "polite" | "assertive";
}) {
  return <section className={`arena-fixture ${className}`} aria-label={label} data-art={dataArt} style={style} aria-live={ariaLive}>{children}</section>;
}

export function RecordSectionTabs({ items, active, label = "기록 분류" }: {
  items: { key: string; label: string; href: string }[];
  active: string;
  label?: string;
}) {
  return <nav className="profile-section-tabs record-section-tabs" aria-label={label}>
    {items.map((item) => <Link key={item.key} href={item.href} scroll={false}
      aria-current={active === item.key ? "page" : undefined}>{item.label}</Link>)}
  </nav>;
}

export function RecordContentPanel({ children, id, className = "" }: {
  children: ReactNode; id?: string; className?: string;
}) {
  return <section id={id} className={`record-content-panel ${className}`}>{children}</section>;
}

export function RecordEventList({ children }: { children: ReactNode }) {
  return <ul className="record-event-list">{children}</ul>;
}

export function RecordEventItem({ children }: { children: ReactNode }) {
  return <li className="record-event-item">{children}</li>;
}

export function RecordTimeline({ children }: { children: ReactNode }) {
  return <div className="personal-timeline">{children}</div>;
}

export function RecordTimelineYear({ year, label = "참여 경기" }: { year: string; label?: string }) {
  return <div className="arena-match-row personal-timeline-year"><strong>{year}</strong><span /><small>{label}</small></div>;
}

export function RecordTimelineRow({ id, dateTime, date, title, result, children }: {
  id?: string; dateTime: string; date: ReactNode; title?: string;
  result?: "win" | "loss" | "draw" | "unknown";
  children: ReactNode;
}) {
  return <div id={id} className="arena-match-row personal-timeline-row" data-result={result}>
    <time dateTime={dateTime} title={title}>{date}</time>
    <span className="personal-timeline-track"><i /></span>
    <div className="personal-timeline-card">{children}</div>
  </div>;
}
