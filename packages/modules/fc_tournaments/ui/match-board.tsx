"use client";
/**
 * 경기 탭. 롤 대진표 탭의 필터(라운드·팀) 자리에 FC 는 참가자 필터 하나를 둔다 —
 * 대진(라운드) 정보가 저장돼 있지 않아 경기 순서대로 늘어놓는다.
 * 클라이언트로는 화면에 필요한 칸만 넘긴다(match_info 원본을 싣지 않는다).
 */
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "../../../ui/avatar.tsx";

export interface BoardSide {
  key: string;
  name: string;
  image: string | null;
  channelId: string | null;
  score: number | null;
  outcome: "win" | "draw" | "loss" | "unknown";
  /** 동점 경기의 승부차기 점수 */
  shootout?: number | null;
}
export interface BoardMatch {
  id: string;
  href: string;
  no: number;
  time: string;
  mode: string;
  levelDecided: boolean;
  series: string | null;
  sides: BoardSide[];
}

export function MatchCard({ match, muted = false }: { match: BoardMatch; muted?: boolean }) {
  return <Link href={match.href} className={`ft-match-card ${muted ? "ft-match-muted" : ""}`}>
    <small>
      <b>{match.no}경기</b> · {match.time} · {match.mode}
      {match.series && <> · {match.series}</>}
    </small>
    {match.sides.map((s) => <span key={s.key} className={s.outcome === "win" ? "ft-match-winner" : s.outcome === "draw" ? "ft-match-draw" : ""}>
      <span className="ft-person-photo ft-person-sm"><Avatar name={s.name} src={s.image} channelId={s.channelId} /></span>
      <b>{s.name}</b>
      {s.outcome === "win" && <i>승</i>}
      <strong>{s.score ?? "?"}{s.shootout != null && <small className="ft-pk">({s.shootout})</small>}</strong>
    </span>)}
    {match.levelDecided && <em>{match.sides.some((s) => s.shootout != null) ? "승부차기" : "동점 승부 · 승패는 경기 기록 기준"}</em>}
  </Link>;
}

export function MatchBoard({ matches, people }: { matches: BoardMatch[]; people: { key: string; name: string }[] }) {
  const [who, setWho] = useState("all");
  const mine = (m: BoardMatch) => who === "all" || m.sides.some((s) => s.key === who);
  const shown = matches.filter(mine);
  const record = who === "all" ? null : shown.reduce((r, m) => {
    const o = m.sides.find((s) => s.key === who)?.outcome;
    if (o === "win") r.w++; else if (o === "loss") r.l++; else if (o === "draw") r.d++;
    return r;
  }, { w: 0, d: 0, l: 0 });
  return <>
    <div className="ft-filters">
      <label>
        참가자
        <select aria-label="참가자" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="all">전체 참가자</option>
          {people.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
      </label>
      <span aria-live="polite">
        {shown.length}경기{record && <> · {record.w}승 {record.d}무 {record.l}패</>}
      </span>
      {who !== "all" && <button type="button" onClick={() => setWho("all")}>초기화</button>}
    </div>
    <p className="ft-footnote ft-filter-hint">경기를 누르면 당시 스쿼드와 경기 지표가 있는 경기 상세로 이동합니다. 경기 번호는 이 대회에서 기록된 순서입니다.</p>
    <div className="ft-match-grid">
      {shown.map((m) => <MatchCard key={m.id} match={m} />)}
    </div>
    {shown.length === 0 && <div className="ft-empty">선택한 참가자의 경기가 없습니다.</div>}
  </>;
}
