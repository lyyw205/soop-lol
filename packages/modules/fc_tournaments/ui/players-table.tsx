"use client";
/**
 * 참가자 탭. 대회 기록(경기·승무패·득실) 옆에 지금의 구단 정보(팀컬러·구단가치·이번 시즌 공식경기 점수)를 붙인다.
 * ★ 구단 정보는 **대회 당시가 아니라 현재** 값이다(수집이 2026-10-02 부터라 그 전 대회 당시 값은 없다). 헤더·툴팁에 그렇게 적는다.
 * 기본 정렬은 대회 순위(대진표 계산). 대진이 없어 순위를 모르면 이름순 — 승수로 줄 세우면 순위처럼 읽힌다.
 */
import Link from "next/link";
import { useState } from "react";
import type { FcoClubAccountSummary } from "@soop-lol/core/lib/contract";
import { formatWon } from "@soop-lol/core/lib/contract/client";
import { Avatar } from "../../../ui/avatar.tsx";
import { TeamColorIcons } from "../../../ui/fc/team-colors.tsx";

export interface PlayerRow {
  key: string;
  /** 대회 순위(대진표 계산 — 공식 발표 우선). 대진이 없거나 순위가 안 정해졌으면 null */
  rank: { min: number; text: string; note: string } | null;
  name: string;
  href: string | null;
  image: string | null;
  channelId: string | null;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  form: ("win" | "draw" | "loss" | "unknown")[];
  /** 지금의 구단 정보. FC 계정 구단 조회가 없으면 null */
  club: Pick<FcoClubAccountSummary, "club_value" | "captured_at" | "teamColors" | "rating"> | null;
}

type SortKey = "rank" | "name" | "value" | "rating" | "wins" | "diff";
const pick: Record<SortKey, (r: PlayerRow) => number | string | null> = {
  rank: (r) => r.rank?.min ?? null,
  name: (r) => r.name,
  value: (r) => r.club?.club_value ?? null,
  // 등급 순서(order)는 클수록 높은 등급이다(grades.ts) — 처음 누르면 높은 등급부터
  rating: (r) => r.club?.rating?.currentGrade?.order ?? null,
  wins: (r) => r.wins,
  diff: (r) => r.goalsFor - r.goalsAgainst,
};
const kst = (iso: string | null | undefined) =>
  iso ? new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ") + " KST" : "미조회";
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const outcomeLabel = (o: PlayerRow["form"][number]) => (o === "win" ? "승" : o === "loss" ? "패" : o === "draw" ? "무" : "?");

export function PlayersTable({ rows }: { rows: PlayerRow[] }) {
  // 기본은 대회 순위. 대진이 없어 순위를 모르는 대회는 이름순(승수로 줄 세우면 순위처럼 읽힌다)
  const ranked = rows.some((r) => r.rank);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: ranked ? "rank" : "name", asc: true });
  const sorted = [...rows].sort((a, b) => {
    const av = pick[sort.key](a), bv = pick[sort.key](b);
    // 값이 없는 사람(구단 미조회)은 정렬 방향과 무관하게 맨 아래 — 0으로 섞지 않는다
    if (av == null) return bv == null ? a.name.localeCompare(b.name, "ko") : 1;
    if (bv == null) return -1;
    const c = typeof av === "string" ? av.localeCompare(String(bv), "ko") : av - (bv as number);
    return (sort.asc ? c : -c) || a.name.localeCompare(b.name, "ko");
  });
  // 숫자 칸은 처음 누르면 큰 값부터, 이름은 가나다순부터
  const head = (key: SortKey, label: string, title?: string) => <button type="button" className="ft-sort" data-active={sort.key === key}
    title={title} aria-label={`${label} 정렬${sort.key === key ? ` · 현재 ${sort.asc ? "오름차순" : "내림차순"}` : ""}`}
    onClick={() => setSort(sort.key === key ? { key, asc: !sort.asc } : { key, asc: key === "name" || key === "rank" })}>
    {label}<span aria-hidden="true">{sort.key === key ? (sort.asc ? "↑" : "↓") : "↕"}</span>
  </button>;

  return <div className="ft-table-scroll" role="region" tabIndex={0} aria-label="참가자 기록">
    <table className="ft-table ft-players-table">
      <thead><tr>
        {ranked && <th className="ft-col-center">{head("rank", "순위", "대진표로 정해진 대회 순위 — 공식 발표가 있으면 공식")}</th>}
        <th className="ft-col-name">{head("name", "참가자")}</th>
        <th className="ft-col-center ft-col-color">팀컬러</th>
        <th className="ft-col-num ft-col-value">{head("value", "구단가치", "현재 공식 구단가치(넥슨 공식 홈페이지) — 대회 당시 값이 아니다")}</th>
        <th className="ft-col-center ft-col-season">{head("rating", "이번 시즌", "현재 시즌 1대1 공식경기 등급 — 대회 당시 값이 아니다")}</th>
        <th className="ft-col-num">경기</th>
        <th className="ft-col-num">{head("wins", "승")}</th>
        <th className="ft-col-num">무</th>
        <th className="ft-col-num">패</th>
        <th className="ft-col-num">득점</th>
        <th className="ft-col-num">실점</th>
        <th className="ft-col-num">{head("diff", "득실")}</th>
        <th>경기 흐름</th>
      </tr></thead>
      <tbody>{sorted.map((p) => <tr key={p.key}>
        {ranked && <td className={`ft-col-center ft-rank${p.rank?.min === 1 ? " ft-rank-top" : ""}`} title={p.rank?.note ?? "순위 미정"}>
          {p.rank?.text ?? "—"}
        </td>}
        <th scope="row"><span className="ft-table-person">
          <span className="ft-person-photo ft-person-sm"><Avatar name={p.name} src={p.image} channelId={p.channelId} /></span>
          {p.href ? <Link href={p.href}>{p.name}</Link> : p.name}
        </span></th>
        <td className="ft-col-center ft-col-color"><TeamColorIcons observation={p.club?.teamColors ?? null} size={22} /></td>
        <td className="ft-col-num ft-col-value ft-value" title={p.club?.club_value != null ? `${kst(p.club.captured_at)} 조회` : "공식 구단가치 미조회"}>
          {p.club?.club_value != null ? formatWon(p.club.club_value) : "—"}
        </td>
        <td className="ft-col-center ft-col-season" title={p.club?.rating?.currentGrade
          ? `현재 시즌 1대1 공식경기 · ${kst(p.club.rating.gradesCheckedAt)} 조회` : "현재 시즌 공식경기 등급 미조회"}>
          {p.club?.rating?.currentGrade
            ? <span className="ft-season">
              <img src={p.club.rating.currentGrade.icon} alt="" width={34} height={34} loading="lazy" referrerPolicy="no-referrer" />
              <small>{p.club.rating.currentGrade.name}</small>
            </span>
            : <span className="fct-none">—</span>}
        </td>
        <td className="ft-col-num">{p.games}</td>
        <td className="ft-col-num ft-num-win">{p.wins}</td>
        <td className="ft-col-num">{p.draws}</td>
        <td className="ft-col-num ft-num-loss">{p.losses}</td>
        <td className="ft-col-num">{p.goalsFor}</td>
        <td className="ft-col-num">{p.goalsAgainst}</td>
        <td className="ft-col-num">{signed(p.goalsFor - p.goalsAgainst)}</td>
        <td><span className="ft-form" aria-label={`경기 순서대로 ${p.form.map(outcomeLabel).join(" ")}`}>
          {p.form.map((o, i) => <i key={i} className={`ft-o-${o}`} aria-hidden="true">{outcomeLabel(o)}</i>)}
        </span></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
