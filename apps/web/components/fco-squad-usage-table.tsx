"use client";

import { useState } from "react";

/**
 * 개인 전적 스쿼드 표. 헤더를 누를 때마다 정렬이 바뀐다:
 * 숫자 열은 내림차순 → 오름차순 → 해제, 글자 열(선수·포지션)은 오름차순 → 내림차순 → 해제.
 * "해제" 는 서버가 준 원래 순서(출전 많은 순, 같으면 골 많은 순)다. 평점이 없는 선수는 방향과 상관없이 맨 아래.
 *
 * 오른쪽 위 칩으로 범위를 고른다: 전체 / 최근 5·10·20·30경기. 범위마다 서버가 따로 집계해 넘긴다
 * (사용률 분모가 범위의 경기 수라서). 범위를 바꿔도 정렬은 유지한다.
 */

export interface SquadUsageRow {
  id: number;
  name: string;
  seasonIcon: string | null;
  seasonName: string | null;
  position: string;
  positionId: number;
  games: number;
  usage: number;
  goals: number;
  assists: number;
  rating: number | null;
}

export interface SquadWindow {
  key: string;
  label: string;
  /** 이 범위의 경기 수(사용률 분모) */
  games: number;
  /** 이 범위에서 줄에 올리는 최소 출전 수 */
  minGames: number;
  rows: SquadUsageRow[];
}

type Key = "name" | "position" | "games" | "usage" | "goals" | "rating";
type Dir = "asc" | "desc";

const COLUMNS: { key: Key; label: string; text?: boolean; className?: string }[] = [
  { key: "name", label: "선수", text: true, className: "record-col-name" },
  { key: "position", label: "포지션", text: true },
  { key: "games", label: "출전" },
  { key: "usage", label: "사용률" },
  { key: "goals", label: "골 · 도움" },
  { key: "rating", label: "평점" },
];

function compare(a: SquadUsageRow, b: SquadUsageRow, key: Key): number {
  switch (key) {
    case "name": return a.name.localeCompare(b.name, "ko");
    case "position": return a.positionId - b.positionId;
    case "goals": return a.goals - b.goals || a.assists - b.assists;
    case "rating": return (a.rating ?? 0) - (b.rating ?? 0);
    default: return a[key] - b[key];
  }
}

export function FcoSquadUsageTable({ windows }: { windows: SquadWindow[] }) {
  const [sort, setSort] = useState<{ key: Key; dir: Dir } | null>(null);
  const [windowKey, setWindowKey] = useState(windows[0]?.key ?? "all");
  const current = windows.find((w) => w.key === windowKey) ?? windows[0]!;
  const rows = current.rows;

  const cycle = (key: Key, text?: boolean) => {
    const first: Dir = text ? "asc" : "desc";
    const second: Dir = text ? "desc" : "asc";
    setSort((cur) => cur?.key !== key ? { key, dir: first } : cur.dir === first ? { key, dir: second } : null);
  };

  const shown = !sort ? rows : [...rows].sort((a, b) => {
    // 평점이 없는 선수는 어느 방향이든 맨 아래
    if (sort.key === "rating" && (a.rating == null) !== (b.rating == null)) return a.rating == null ? 1 : -1;
    const c = compare(a, b, sort.key);
    return sort.dir === "asc" ? c : -c;
  });

  const bar = (row: SquadUsageRow) => <td className="fc-squad-usage-bar"><span className="champion-bar" aria-hidden="true">
    <i style={{ width: `${Math.min(100, row.usage * 100)}%` }} /></span></td>;

  return <div className="fc-squad-usage">
    <div className="fc-squad-head">
      <h2 className="text-ink-200">스쿼드 분석</h2>
      <div className="fc-squad-windows" role="group" aria-label="집계 범위">
        {windows.map((w) => <button key={w.key} type="button" className="fc-tab" aria-pressed={w.key === current.key}
          onClick={() => setWindowKey(w.key)}>{w.label}</button>)}
      </div>
    </div>
    <p className="fc-desc mb-3">현재 보유 스쿼드가 아니라 경기 당시 사용한 선수들의 기록입니다.</p>
    <p className="fc-squad-count" title="선발이든 교체든 실제로 뛴 경기만 셉니다. 교체 명단에만 있고 안 뛴 경기는 빠집니다.">
      {current.games}경기 중 {current.minGames > 1 ? `${current.minGames}경기 이상 ` : ""}출전 · {rows.length}명
    </p>
    {rows.length === 0 ? <p className="personal-history-empty">{current.minGames}경기 이상 뛴 선수가 없습니다.</p> :
    <div className="record-table-wrap"><table className="record-table fc-squad-record-table">
    <thead><tr>
      <th scope="col" className="record-col-rank">#</th>
      {COLUMNS.map((col) => {
        const on = sort?.key === col.key;
        const th = <th key={col.key} scope="col" className={col.className}
          aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
          <button type="button" className="fc-sort" data-dir={on ? sort!.dir : undefined} onClick={() => cycle(col.key, col.text)}>
            {col.label}<i aria-hidden="true" />
          </button>
        </th>;
        // 사용률 앞에는 막대 칸(정렬 없음)이 있다
        return col.key === "usage"
          ? [<th key="bar" scope="col" className="fc-squad-usage-bar"><span className="sr-only">출전 비중 막대</span></th>, th]
          : th;
      })}
    </tr></thead>
    <tbody>{shown.map((row, index) => <tr key={row.id}>
      <td className="record-col-rank">{index + 1}</td>
      <th scope="row" className="record-col-name"><span className="record-cell-name">
        {row.seasonIcon
          ? <img className="fc-squad-season" src={row.seasonIcon} alt={row.seasonName ?? ""} title={row.seasonName ?? undefined} loading="lazy" />
          : <span className="record-icon-blank" aria-hidden="true">?</span>}
        <span title={row.name}>{row.name}</span>
      </span></th>
      <td>{row.position}</td>
      <td className="champion-col-games">{row.games}</td>
      {bar(row)}
      <td className="fc-squad-usage-rate">{Math.round(row.usage * 100)}%</td>
      <td><span className="record-wl"><span>{row.goals}골</span><span>{row.assists}도움</span></span></td>
      <td>{row.rating == null ? "—" : row.rating.toFixed(1)}</td>
    </tr>)}</tbody>
  </table></div>}
  </div>;
}
