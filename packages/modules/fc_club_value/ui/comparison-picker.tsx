"use client";

import { useId, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { MAX_PLAYERS } from "./comparison-config.ts";

export interface PlayerOption {
  key: string; name: string; meta: string; price: string; href: string;
  grade: number | null; ovr: number | null; exactPrice?: string;
  change7: { delta: number; pct: number; since: string } | null;
  season: string; seasonIcon: string | null;
  selected: boolean; available: boolean; color?: string;
}

export function ComparisonPicker({ slug, players, count }: {
  slug: string; players: PlayerOption[]; count: number;
}) {
  return <PickerContents key={slug} players={players} count={count} />;
}

function PickerContents({ players, count }: { players: PlayerOption[]; count: number }) {
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const id = useId();
  const filtered = players.filter(p => `${p.name} ${p.meta}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="cv-player-picker" aria-label="선수 가치 비교" aria-busy={pending}>
    <div className="cv-picker-toolbar">
      <h2>선수 선택 <small>{players.length}장 · 가치순</small></h2>
      <label className="cv-quick-search" htmlFor={id}>
        <span className="cv-sr-only">선수 검색</span>
        <input id={id} type="search" placeholder="선수명 · 시즌 검색" value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      <span className="cv-picker-count">{count} / {MAX_PLAYERS}</span>
    </div>
    <p className="cv-quick-status" role="status">{pending ? "차트에 반영 중…" : count === MAX_PLAYERS ? `${MAX_PLAYERS}명 선택 완료 · 선택한 선수를 누르면 해제` : "선택하면 구단 곡선 대신 선수 가치 곡선을 보여줍니다"}</p>
    <div className="cv-player-columns" aria-hidden="true"><span>선수</span><span>강화</span><span className="cv-player-ovr">OVR</span><span>현재가</span><span>7일 등락</span></div>
    <div className="cv-quick-list" tabIndex={0} aria-label="비교할 선수 목록">
      {filtered.map(p => <button key={p.key} type="button" className="cv-quick-player" aria-pressed={p.selected}
        style={p.selected ? { "--cv-player-color": p.color } as CSSProperties : undefined}
        disabled={pending || !p.available || (!p.selected && count >= MAX_PLAYERS)}
        onClick={() => startTransition(() => router.push(p.href, { scroll: false }))}>
        <span className="cv-quick-identity">
          <span className="cv-player-name">
            {p.seasonIcon && <img className="cv-season-icon" src={p.seasonIcon} alt={p.season} title={p.season} loading="lazy"
              onError={e => { e.currentTarget.hidden = true; e.currentTarget.nextElementSibling?.removeAttribute("hidden"); }} />}
            <span className="cv-season-fallback" hidden={Boolean(p.seasonIcon)}>{p.season}</span>
            <strong>{p.name}</strong>
          </span>
          {p.ovr !== null && <small className="cv-player-attributes">OVR {p.ovr}</small>}
        </span>
        <span className="cv-player-grade">
          {p.grade !== null && p.grade >= 0 && p.grade <= 13
            ? <img className="cv-grade-icon" src={`/images/fco-grades/${p.grade}.png`} alt={`${p.grade}강`} title={`${p.grade}강`} width={23} height={14} loading="lazy" />
            : <span title="강화 미확인">?</span>}
        </span>
        <span className="cv-player-ovr" aria-label={`OVR ${p.ovr ?? "미확인"}`}>{p.ovr ?? "—"}</span>
        <span className="cv-quick-price" title={p.exactPrice ? `${p.exactPrice}원` : undefined}>
          <strong>{p.price}</strong>
          {!p.available && <small>시세 없음</small>}
        </span>
          <span className={`cv-player-change cv-change cv-${p.change7 ? p.change7.delta > 0 ? "up" : p.change7.delta < 0 ? "down" : "flat" : "flat"}`}
            title={p.change7 ? `${p.change7.since} 대비 7일 등락률` : "7일 전 시세 기록 없음"}>
            {p.change7 ? <><span className="cv-change-arrow">{p.change7.delta > 0 ? "▲" : p.change7.delta < 0 ? "▼" : "–"}</span>{" "}{Math.abs(p.change7.pct).toFixed(p.change7.pct !== 0 && Math.abs(p.change7.pct) < .1 ? 2 : 1)}%</> : "7일 —"}
          </span>
      </button>)}
      {!filtered.length && <p className="cv-quick-empty">{players.length ? "검색 결과가 없습니다." : "아직 받은 스쿼드가 없습니다."}</p>}
    </div>
  </section>;
}
