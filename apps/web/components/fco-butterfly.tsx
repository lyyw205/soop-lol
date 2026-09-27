import type { ReactNode } from "react";

/**
 * 슛 카드·패스 카드가 같이 쓰는 나비형 막대.
 * 가운데 지표명, 왼쪽으로 왼쪽 참가자, 오른쪽으로 오른쪽 참가자.
 * 한쪽당 막대 하나에 두 값을 겹친다: 옅은 막대 전체 = total(슛·시도), 안쪽부터 채운 진한 부분 = fill(골·성공).
 * 막대 길이는 모든 줄 중 가장 큰 total 에 맞추고, 끝에 "fill/total" 을 적는다.
 * 격자 칸에 따로 놓을 수 있게 머리줄 · 줄들 · 범례를 나눠 돌려준다.
 */

export interface BfSide { fill: number; total: number }
export interface BfRow {
  key: string;
  label: string;
  a: BfSide;
  b: BfSide;
  /** 이 줄 위에 굵은 구분선 (묶음이 바뀌는 자리) */
  divider?: boolean;
}

export function bfParts({ rows, focus, names, summaries, keyText, ariaUnit }: {
  rows: BfRow[];
  /** "all" 이면 양쪽 모두 선명, 0/1 이면 그쪽만 선명하고 상대는 흐리게 남긴다 */
  focus: "all" | 0 | 1;
  names: [string, string];
  summaries: [string, string];
  /** 범례 문구 — 예: "진한 부분 골 · 막대 전체 슛 · 숫자는 골/슛" */
  keyText: ReactNode;
  /** 화면 낭독용 단위 — 예: ["골", "슛"] */
  ariaUnit: [string, string];
}) {
  const max = Math.max(1, ...rows.flatMap((row) => [row.a.total, row.b.total]));
  const side = (i: 0 | 1, v: BfSide) => <div className="fc-bf-side" data-side={i} data-dim={focus !== "all" && focus !== i}>
    <span className="fc-bf-track" style={{ width: `${v.total / max * 100}%` }}>
      <i style={{ width: v.total ? `${v.fill / v.total * 100}%` : 0 }} />
    </span>
    <em data-zero={v.total === 0}>{v.total === 0 ? "0" : <><b data-zero={v.fill === 0}>{v.fill}</b>/{v.total}</>}</em>
  </div>;

  return {
    head: <div className="fc-bf-head">
      <span data-side="0" data-dim={focus === 1}><b>{names[0]}</b><small>{summaries[0]}</small></span>
      <span data-side="1" data-dim={focus === 0}><b>{names[1]}</b><small>{summaries[1]}</small></span>
    </div>,
    rows: <div className="fc-bf-rows">
      {rows.map((row) => <div className={`fc-bf-row${row.divider ? " is-first-type" : ""}`} key={row.key}
        aria-label={`${row.label}: ${names[0]} ${ariaUnit[0]} ${row.a.fill} ${ariaUnit[1]} ${row.a.total}, ${names[1]} ${ariaUnit[0]} ${row.b.fill} ${ariaUnit[1]} ${row.b.total}`}>
        {side(0, row.a)}
        {/* "(추정)" 은 작은 둘째 줄로 — 가운데 칸 폭을 넘겨 막대를 덮지 않게 */}
        <span className="fc-bf-label">{row.label.endsWith("(추정)")
          ? <>{row.label.replace("(추정)", "")}<small>(추정)</small></> : row.label}</span>
        {side(1, row.b)}
      </div>)}
    </div>,
    key: <div className="fc-bf-key" aria-hidden="true">
      <span className="fc-bf-key-bar"><i /></span>
      <span>{keyText}</span>
    </div>,
  };
}
