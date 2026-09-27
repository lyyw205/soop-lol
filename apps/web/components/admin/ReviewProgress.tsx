import Link from "next/link";
import { ROSTER_PROGRESS_FIELDS } from "@/lib/ck-review-progress";

type ReviewProgressProps = {
  matches: number; completed: number; positions: number; linked: number; champions: number; kda: number; href?: string;
};

const COLUMNS = ["등록 경기", "검수 완료", ...ROSTER_PROGRESS_FIELDS.map(field => field.label)];
const STATE_LABELS = { full: "모두 채움", partial: "일부 채움", empty: "비어 있음", none: "대상 경기 없음", count: "등록 경기 수" };

export function ReviewProgressHeaders({ includeRegistration = true }: { includeRegistration?: boolean } = {}) {
  return COLUMNS.filter(label => includeRegistration || label !== "등록 경기")
    .map(label => <th key={label} scope="col" className="ck-progress-column">{label}</th>);
}

/** 자리 수는 경기마다 합산한다. 같은 사람이 여러 경기에 나오면 각 경기의 한 자리다. */
export function ReviewProgressCells({ matches, completed, positions, linked, champions, kda, href, includeRegistration = true, includeReview = true }: ReviewProgressProps & {
  includeRegistration?: boolean; includeReview?: boolean;
}) {
  const counts = { position_count: positions, linked_count: linked, champion_count: champions, kda_count: kda };
  const target = (query: string) => href ? `${href}${href.includes("?") ? "&" : "?"}${query}` : undefined;
  const metrics = [
    ...(includeRegistration ? [{ label: COLUMNS[0], count: matches, total: null, link: href }] : []),
    ...(includeReview ? [{ label: COLUMNS[1], count: completed, total: matches, link: target("review=pending") }] : []),
    ...ROSTER_PROGRESS_FIELDS.map(field => ({ label: field.label, count: counts[field.count], total: matches * 10, link: target(`focus=${field.focus}`) })),
  ];

  return metrics.map(({ label, count, total, link }) => {
    // 등록 경기 수에는 수집 목표가 없으므로 완료 색상을 붙이지 않는다.
    const state = total === null ? "count" : total === 0 ? "none" : count === 0 ? "empty" : count === total ? "full" : "partial";
    const value = total === null ? `${count}경기` : total === 0 ? "—" : `${count}/${total}`;
    const title = `${label}: ${value} · ${STATE_LABELS[state]}`;
    return <td key={label} className="ck-progress-column">
      {link
        ? <Link href={link} className="ck-progress-value" data-state={state} title={title} aria-label={title}>{value}</Link>
        : <span className="ck-progress-value" data-state={state} title={title} aria-label={title}>{value}</span>}
    </td>;
  });
}

export function ReviewProgress(props: ReviewProgressProps) {
  return <div className="ck-review-progress ck-progress-scroll" role="region" aria-label="데이터와 검수 현황" tabIndex={0}>
    <table className="ck-progress-table">
      <caption className="sr-only">등록 경기와 검수·입력 현황</caption>
      <thead><tr><ReviewProgressHeaders /></tr></thead>
      <tbody><tr><ReviewProgressCells {...props} /></tr></tbody>
    </table>
  </div>;
}
