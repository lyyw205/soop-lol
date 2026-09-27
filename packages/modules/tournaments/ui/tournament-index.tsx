"use client";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { RecordTimelineRow } from "../../../ui/record-structure.tsx";
import type { TournamentSummary } from "../server/tournament.ts";
import {
  TournamentHero,
  tournamentHref,
  categoryLabel,
  period,
} from "./tournament-shared.tsx";
export function TournamentIndex({ events }: { events: TournamentSummary[] }) {
  const params = useSearchParams(),
    router = useRouter();
  const category = ["meljang", "event"].includes(params.get("category") ?? "")
    ? params.get("category")!
    : "all";
  const year = params.get("year") ?? "all",
    q = params.get("q")?.trim() ?? "";
  const query = q.toLocaleLowerCase();
  const matches = events.filter(
    (e) =>
      (category === "all" || e.category === category) &&
      (year === "all" || e.start?.startsWith(year)) &&
      (!query ||
        [e.name, ...e.searchNames]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
  );
  const [latest, ...rest] = matches;
  const yearGroups = new Map<string, TournamentSummary[]>();
  for (const event of rest) {
    const eventYear = event.start?.slice(0, 4) ?? "미정";
    const group = yearGroups.get(eventYear) ?? [];
    group.push(event);
    yearGroups.set(eventYear, group);
  }
  const years = [
    ...new Set(
      events.map((e) => e.start?.slice(0, 4)).filter((y): y is string => !!y),
    ),
  ]
    .sort()
    .reverse();
  function url(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "all" || !value) next.delete(key);
    else next.set(key, value);
    return `/tournaments${next.size ? "?" + next.toString() : ""}`;
  }
  return (
    <>
      <div className="tp-page-title">
        <div>
          <p className="tp-eyebrow">TOURNAMENTS & EVENTS</p>
          <h1>
            대회<span>.</span>
          </h1>
          <p>멸망전부터 이벤트 매치까지, 함께 만든 승부의 기록.</p>
        </div>
        <span>{events.length}개의 대회·이벤트</span>
      </div>
      <div className="tp-index-toolbar">
        <nav className="tp-category-tabs" aria-label="대회 분류">
          {[
            ["all", "전체"],
            ["meljang", "멸망전"],
            ["event", "이벤트 매치"],
          ].map(([key, label]) => (
            <Link
              key={key}
              href={url("category", key)}
              aria-current={category === key ? "page" : undefined}
              scroll={false}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form className="tp-search-form" action="/tournaments">
          <input type="hidden" name="category" value={category} />
          <input type="hidden" name="year" value={year} />
          <label>
            <Search size={16} />
            <input
              key={q}
              name="q"
              defaultValue={q}
              placeholder="대회, 팀, 스트리머 검색"
              aria-label="대회, 팀, 스트리머 검색"
            />
          </label>
          <button type="submit">검색</button>
        </form>
      </div>
      <div className="tp-list-meta">
        <p>
          <b>{matches.length}</b>개의 기록 <span>· 최신순</span>
        </p>
        <label>
          연도{" "}
          <select
            aria-label="대회 연도"
            value={year}
            onChange={(e) =>
              router.push(url("year", e.target.value), { scroll: false })
            }
          >
            <option value="all">전체 연도</option>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </label>
      </div>
      {latest ? (
        <>
          <div className="tp-featured-row arena-match-row">
            <strong className="tp-featured-label">LATEST</strong>
            <span className="tp-featured-track" aria-hidden="true"><i /></span>
            <div className="tp-featured-card">
              <TournamentHero event={latest} compact />
            </div>
          </div>
          {rest.length > 0 && (
            <div className="tp-table-scroll">
              <div className="tp-catalog personal-timeline" aria-label="연도별 대회 목록">
                {[...yearGroups].map(([eventYear, group]) => (
                <section key={eventYear} className="tp-year-group" aria-label={`${eventYear}년 대회`}>
                  <ul className="tp-catalog-list">
                  {group.map((e, index) => (
                    <li key={e.id}>
                      <RecordTimelineRow date={index === 0 ? <strong className="tp-year-marker">{eventYear}</strong> : null} dateTime={e.start ?? ""} title={e.name}>
                      <div className="personal-match-detail tp-catalog-columns">
                      <div className="tp-catalog-title">
                        <span className="tp-table-category">
                          {categoryLabel(e)}
                        </span>
                        <Link href={tournamentHref(e.slug)}>{e.name}</Link>
                      </div>
                      <div>
                        {period(e)}
                        {e.dateFromMatches && <small>경기 기록 기준</small>}
                      </div>
                      <div>{e.organizer ?? "미확인"}</div>
                      <div>{e.teamCount ? `${e.teamCount}팀` : "미수집"}</div>
                      <div>
                        {e.seriesCount}경기 <span className="tp-record-separator">·</span> {e.setCount}세트
                      </div>
                      <div>
                        {e.winner ? (
                          <span className="tp-winner">
                            <span className="tp-winner-logo" aria-hidden="true">
                              {e.winner.slice(0, 1)}
                            </span>
                            {e.winner}
                          </span>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div>
                        <Link
                          href={tournamentHref(e.slug)}
                          aria-label={`${e.name} 상세 보기`}
                        >
                          <ArrowRight size={17} />
                        </Link>
                      </div>
                      </div>
                      </RecordTimelineRow>
                    </li>
                  ))}
                  </ul>
                </section>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="tp-empty">
          <Search />
          <h2>조건에 맞는 대회가 없어요</h2>
          <p>다른 이름이나 연도로 찾아보세요.</p>
          <Link href="/tournaments">필터 초기화</Link>
        </div>
      )}
      <p className="tp-footnote">
        확인된 경기와 참가 팀을 기준으로 표시합니다. 팀·세트 수는 수집 범위에
        따라 달라질 수 있습니다.
      </p>
    </>
  );
}
