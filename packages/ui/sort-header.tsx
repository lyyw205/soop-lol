import Link from "next/link";
import type { ReactNode } from "react";

/** 링크/버튼 동작은 보존하고 레이블과 SVG가 함께 열의 가운데에 정렬된다. */
export function SortHeader({children, label, direction, href, onClick, className, controlClassName = "record-sort", as = "th", title}: {
  children: ReactNode; label: string; direction?: "asc" | "desc";
  href?: string; onClick?: () => void; className?: string; controlClassName?: string;
  as?: "th" | "span"; title?: string;
}) {
  const Tag = as;
  const content = <><span>{children}</span><svg viewBox="0 0 12 14" width="12" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flex:"0 0 12px"}}>
    <path d={direction === "asc" ? "M6 11V3M2.5 6.5 6 3l3.5 3.5" : direction === "desc" ? "M6 3v8M2.5 7.5 6 11l3.5-3.5" : "M3 11V3M.75 5.25 3 3l2.25 2.25M9 3v8M6.75 8.75 9 11l2.25-2.25"} />
  </svg></>;
  const props = {className:controlClassName, title, "data-active": !!direction, "aria-label":`${label} 정렬${direction ? ` · 현재 ${direction === "asc" ? "오름차순" : "내림차순"}` : ""}`, style:{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:4,whiteSpace:"nowrap"} as const};
  return <Tag scope={as === "th" ? "col" : undefined} role={as === "span" ? "columnheader" : undefined} className={className}
    aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
    {href ? <Link {...props} href={href} scroll={false}>{content}</Link> : <button {...props} type="button" onClick={onClick}>{content}</button>}
  </Tag>;
}
export function ChangeDirection({delta}: {delta:number}) {
  return <svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-label={delta > 0 ? "상승" : delta < 0 ? "하락" : "변동 없음"} style={{display:"inline-block",verticalAlign:"baseline"}}>
    {delta === 0 ? <path d="M1 4h8v2H1z"/> : <path d={delta > 0 ? "M5 1 10 9H0z" : "M0 1h10L5 9z"}/>}
  </svg>;
}
