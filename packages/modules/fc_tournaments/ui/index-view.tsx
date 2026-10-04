/**
 * FC 대회 목록. 롤 대회 목록의 틀(제목 → 검색·연도 → LATEST 카드 → 연도별 목록)을 따른다.
 * 롤의 분류 탭(멸망전/이벤트)은 FC 에 해당 분류가 없어 빼고, 우승 칸은 기록이 없어 참가자 칸으로 바꾼다.
 * 검색·연도는 주소(쿼리)로 받아 서버에서 거른다 — 클라이언트 상태가 필요 없다.
 */
import Link from "next/link";
import { ArrowRight, Search, Trophy } from "lucide-react";
import type { FcoEvent, FcoGame } from "@soop-lol/core/lib/contract";
import { kindLabel, sideScore, type Entrant } from "./model.ts";
import { eventHref, eventPeriod, eventYear, Person, TournamentHero } from "./shared.tsx";
import { tournamentsIndexHref } from "./paths.ts";

export interface IndexEntry {
  event: FcoEvent;
  games: FcoGame[];
  people: Entrant[];
  /** 공통 대진으로 정해진 우승자. 대진이 없으면 null — 승수로 지어내지 않는다 */
  champion: string | null;
}

const year = (e: IndexEntry) => eventYear(e.event, e.games);
const goalsOf = (games: FcoGame[]) => games.reduce((n, g) => n + g.participants.reduce((m, p) => m + (sideScore(p) ?? 0), 0), 0);

export function IndexView({ entries, q, year: wantedYear }: { entries: IndexEntry[]; q: string; year: string }) {
  const query = q.trim().toLocaleLowerCase();
  const matches = entries.filter((e) =>
    (wantedYear === "all" || year(e) === wantedYear) &&
    (!query || [e.event.name, e.event.organizer ?? "", ...e.people.map((p) => p.name)].join(" ").toLocaleLowerCase().includes(query)));
  const years = [...new Set(entries.map(year).filter((y): y is string => !!y))].sort().reverse();
  const [latest, ...rest] = matches;
  const groups = new Map<string, IndexEntry[]>();
  for (const e of rest) {
    const y = year(e) ?? "미정";
    groups.set(y, [...(groups.get(y) ?? []), e]);
  }
  const href = (next: { q?: string; year?: string }) => {
    const params = new URLSearchParams();
    const nq = next.q ?? q, ny = next.year ?? wantedYear;
    if (nq) params.set("q", nq);
    if (ny !== "all") params.set("year", ny);
    return tournamentsIndexHref(params);
  };

  return <>
    <div className="ft-page-title">
      <div>
        <p className="ft-eyebrow">TOURNAMENTS & EVENTS</p>
        <h1>대회<span>.</span></h1>
        <p>스트리머끼리 붙은 FC 온라인 대회 — 누가 누구를 이겼는지, 경기마다의 스코어와 기록.</p>
      </div>
      <span>{entries.length}개의 대회·이벤트</span>
    </div>
    <div className="ft-index-toolbar">
      <nav className="ft-category-tabs" aria-label="대회 연도">
        {["all", ...years].map((y) => <Link key={y} href={href({ year: y })} aria-current={wantedYear === y ? "page" : undefined} scroll={false}>
          {y === "all" ? "전체" : y}
        </Link>)}
      </nav>
      <form className="ft-search-form" action={tournamentsIndexHref()}>
        {wantedYear !== "all" && <input type="hidden" name="year" value={wantedYear} />}
        <label>
          <Search size={16} />
          <input name="q" defaultValue={q} placeholder="대회, 주최, 스트리머 검색" aria-label="대회, 주최, 스트리머 검색" />
        </label>
        <button type="submit">검색</button>
      </form>
    </div>
    <div className="ft-list-meta">
      <p><b>{matches.length}</b>개의 기록 <span>· 최신순</span></p>
      {q && <Link href={href({ q: "" })}>검색어 지우기</Link>}
    </div>
    {latest ? <>
      <div className="ft-featured-row">
        <strong className="ft-featured-label">LATEST</strong>
        <span className="ft-featured-track" aria-hidden="true"><i /></span>
        <div className="ft-featured-card">
          <TournamentHero compact event={latest.event} games={latest.games} people={latest.people}
            champion={latest.champion ? { name: latest.champion } : null}
            numbers={{ people: latest.people.length, games: latest.games.length, goals: goalsOf(latest.games) }} />
        </div>
      </div>
      {rest.length > 0 && <div className="ft-table-scroll">
        <div className="ft-catalog" aria-label="연도별 대회 목록">
          {[...groups].map(([y, group]) => <section key={y} className="ft-year-group" aria-label={`${y}년 대회`}>
            <strong className="ft-year-marker">{y}</strong>
            <ul>{group.map((e) => <li key={e.event.id}>
              <Link className="ft-catalog-row" href={eventHref(e.event.slug)}>
                <span className="ft-catalog-title"><small>{kindLabel(e.event.kind)}</small><b>{e.event.name}</b></span>
                <span>{eventPeriod(e.event, e.games).text}</span>
                <span>{e.event.organizer ?? "주최 미확인"}</span>
                <span className="ft-catalog-faces">
                  {e.people.slice(0, 6).map((p) => <Person key={p.key} entrant={p} size="sm" />)}
                  <small>{e.people.length}명</small>
                </span>
                <span>{e.games.length}경기 <span className="ft-sep">·</span> {goalsOf(e.games)}골</span>
                <span className="ft-catalog-champion">{e.champion ? <><Trophy size={13} />{e.champion}</> : "—"}</span>
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </li>)}</ul>
          </section>)}
        </div>
      </div>}
    </> : <div className="ft-empty">
      <Search />
      <h2>{entries.length ? "조건에 맞는 대회가 없어요" : "등록된 FC 온라인 대회가 없어요"}</h2>
      {entries.length > 0 && <><p>다른 이름이나 연도로 찾아보세요.</p><Link href={tournamentsIndexHref()}>필터 초기화</Link></>}
    </div>}
    <p className="ft-footnote">
      대회에 연결해 확인한 경기만 셉니다. 참가자 수는 연결된 스트리머 계정 기준이며, 조사 범위에 따라 달라질 수 있습니다.
    </p>
  </>;
}
