/**
 * 스트리머 프로필의 섹션들.
 *
 * ★ 왜 탭인가
 *   한 페이지에 아홉 섹션을 세로로 쌓았더니 스크롤이 너무 길어졌다. 상대만 65명이라
 *   그 아래(챔피언·최근 경기)는 사실상 아무도 못 본다.
 *   섹션마다 탭으로 갈라 두고, 첫 탭은 **요약판**을 준다 — 이 사람이 누구인지
 *   한 화면에서 보고, 더 볼 게 있으면 그 탭으로 들어간다.
 *
 * ★ 탭은 주소에 남는다(`?tab=`)
 *   클라이언트 상태로 두면 링크로 공유가 안 되고 새로고침에 사라진다.
 *   그리고 서버가 **그 탭에 필요한 것만 질의**할 수 있다 — 상대 전적 탭이 아니면
 *   경기 이력(세트 전부)을 아예 안 읽는다.
 */

import Link from "next/link";

import type {
  ChampionRow, EventRecord, PlacementSummary, ProfileAccount, RankPoint,
  RecentGame, OpponentGame, OpponentRow,
} from "@soop-lol/core/lib/db/public";
import { OPPONENT_SORTS, type OpponentSort } from "@soop-lol/core/lib/metrics/opponents";
import { POSITION_LABEL, type Position } from "@soop-lol/core/lib/riot/types";

import {
  DualRecord, EmptyLine, Kda, PositionTag, QueueTag, RankChip, RecordBar,
  SectionTitle, TierChart, WinPill, relativeDate,
} from "./public";
import { SeriesLog } from "./series-log";

export const PROFILE_TABS = [
  { key: "summary", label: "요약" },
  { key: "events", label: "대회" },
  { key: "opponents", label: "상대 전적" },
  { key: "champions", label: "챔피언" },
  { key: "games", label: "경기" },
] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number]["key"];
export const DEFAULT_PROFILE_TAB: ProfileTab = "summary";

export function isProfileTab(v: string | null | undefined): v is ProfileTab {
  return PROFILE_TABS.some((t) => t.key === v);
}

/** 주소를 만드는 함수. 탭을 옮겨도 연도·정렬 선택이 살아 있어야 한다. */
export type HrefFor = (next: {
  tab?: ProfileTab;
  year?: number | null;
  sort?: OpponentSort | null;
}) => string;

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-xs ${
    on
      ? "border-accent-400/50 bg-accent-400/10 text-accent-300"
      : "border-ink-800 text-ink-400 hover:text-ink-200"
  }`;

/**
 * 탭 막대.
 *
 * `scroll={false}` 는 여기서도 필수다 — 탭이 화면 위쪽이라 지금은 티가 안 나지만,
 * 스크롤을 내린 상태에서 탭을 누르면 Next 가 맨 위로 올려 버린다.
 */
export function TabBar({
  active, hrefFor, counts,
}: {
  active: ProfileTab;
  hrefFor: HrefFor;
  counts: Partial<Record<ProfileTab, number>>;
}) {
  return (
    <nav className="mt-6 flex flex-wrap gap-1 border-b border-ink-800 pb-px">
      {PROFILE_TABS.map((t) => {
        const n = counts[t.key];
        return (
          <Link
            key={t.key}
            href={hrefFor({ tab: t.key })}
            scroll={false}
            aria-current={active === t.key ? "page" : undefined}
            className={`-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm ${
              active === t.key
                ? "border-accent-400 text-accent-300"
                : "border-transparent text-ink-400 hover:text-ink-200"
            }`}
          >
            {t.label}
            {n !== undefined && n > 0 && (
              <span className="tabular ml-1.5 text-[11px] text-ink-500">{n}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** 요약판에서 "더 있다" 를 알리는 줄. 요약이 전부인 척하면 안 된다. */
export function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 text-right">
      <Link href={href} scroll={false} className="text-[11px] text-ink-400 hover:text-accent-400">
        {children} →
      </Link>
    </div>
  );
}

export function YearFilter({
  years, year, hrefFor, note,
}: {
  years: number[];
  year?: number;
  hrefFor: HrefFor;
  note?: string;
}) {
  if (years.length <= 1) return null;
  return (
    <div className="mb-3 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 shrink-0 text-[11px] text-ink-400">연도</span>
        <Link href={hrefFor({ year: null })} scroll={false} className={chip(year === undefined)}>
          전체
        </Link>
        {years.map((y) => (
          <Link key={y} href={hrefFor({ year: y })} scroll={false} className={chip(year === y)}>
            {y}
          </Link>
        ))}
      </div>
      {note && <p className="mt-2 text-[11px] text-ink-500">{note}</p>}
    </div>
  );
}

/**
 * 수상 내역 — **기본 정보 줄**에 붙는 한 줄짜리 띠.
 *
 * 전에는 탭 안에 5칸짜리 큰 카드로 있었는데, 이 사람이 뭘 이겼는지는
 * 탭을 골라야 보이는 정보가 아니다. 이름 바로 아래가 제자리다.
 *
 * ★ 우승만 강조하고 나머지는 잔글씨다. 다 강조하면 아무것도 강조가 아니다.
 * ★ 0 인 등수는 아예 안 적는다 — 띠가 길어지면 띠가 아니다.
 *   단 우승은 0 이어도 자리를 비우지 않는다(뒤에 준우승부터 이어 적는다).
 *
 * ★ 연도 필터를 **일부러 안 건다.** 여기는 프로필 머리라 어느 탭에서도 같은 값이어야
 *   한다. 연도를 누를 때마다 이름 옆 우승 횟수가 바뀌면 그게 통산인지 그 해인지
 *   알 수 없어진다. 통산이라고 적고 통산을 보여준다.
 */
export function PlacementRibbon({
  placements, href,
}: {
  placements: PlacementSummary;
  href: string;
}) {
  if (placements.total === 0) return null;
  const champion = placements.buckets.find((b) => b.key === "champion");
  const rest = placements.buckets.filter((b) => b.key !== "champion" && b.count > 0);

  return (
    <Link
      href={href}
      scroll={false}
      title="대회 성적 보기"
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] hover:opacity-90"
    >
      {champion && champion.count > 0 && (
        <span className="rounded-md border border-amber-400/45 bg-amber-400/10 px-2 py-0.5 font-medium text-amber-300">
          통산 우승 <span className="tabular">{champion.count}</span>회
        </span>
      )}
      {rest.map((b) => (
        <span key={b.key} className="text-ink-400">
          {b.label} <span className="tabular text-ink-300">{b.count}</span>
        </span>
      ))}
      <span className="text-ink-500">
        · 대회 {placements.total}회
        {/* 버킷 합과 총계가 다른 이유를 안 적으면 숫자가 안 맞는 것처럼 보인다. */}
        {placements.unknown > 0 && ` (순위 미상 ${placements.unknown})`}
      </span>
    </Link>
  );
}

export function AccountList({ accounts }: { accounts: ProfileAccount[] }) {
  return (
    <section>
      <SectionTitle hint="본인이 공개한 근거가 있는 계정만 표시합니다">계정</SectionTitle>
      {accounts.length === 0 ? (
        <EmptyLine>확인된 라이엇 계정이 없습니다.</EmptyLine>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {accounts.map((a) => (
            <li
              key={a.puuid}
              className="flex items-center justify-between gap-3 rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-ink-200">
                  {a.game_name}<span className="text-ink-400">#{a.tag_line}</span>
                </div>
                <div className="text-[11px] text-ink-400">{a.label ?? (a.is_main ? "본계" : "부계")}</div>
              </div>
              <RankChip tier={a.tier} division={a.division} leaguePoints={a.league_points} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TierSection({ points }: { points: RankPoint[] }) {
  return (
    <section>
      <SectionTitle hint="매일 09:00 KST 스냅샷">티어 추이</SectionTitle>
      <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
        <TierChart points={points} />
      </div>
    </section>
  );
}

export function EventList({ events, year }: { events: EventRecord[]; year?: number }) {
  if (events.length === 0) {
    return (
      <EmptyLine>{year ? `${year}년에 나간 대회가 없습니다.` : "아직 대회 기록이 없습니다."}</EmptyLine>
    );
  }
  return (
    <ul className="grid gap-2">
      {events.map((e) => (
        <li key={e.event_slug} className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="font-medium text-ink-200">{e.event_name}</span>
            <span className="text-[11px] text-ink-400">
              {e.placement && (
                <span
                  className={`mr-2 rounded px-1.5 py-0.5 ${
                    e.placement_rank === 1
                      ? "border border-amber-400/40 bg-amber-400/10 text-amber-300"
                      : "border border-ink-700 text-ink-300"
                  }`}
                >
                  {e.placement}
                </span>
              )}
              {e.team_name && <span className="text-ink-300">{e.team_name}</span>}
              {e.position && (
                <span className="ml-1">· {POSITION_LABEL[e.position as Position] ?? e.position}</span>
              )}
              <span className="ml-2">{new Date(e.starts_at).getFullYear()}</span>
            </span>
          </div>
          {/*
            경기가 0건인 이유는 세 가지고, 셋은 전혀 다른 말이다.
              · 예선 탈락(99)      — 본선에 못 올라갔다. 기록이 없는 게 아니라 **없는 게 기록**이다.
              · 본선 순위가 있는데 0 — 올라갔는데 우리가 경기를 못 붙였다. 우리 쪽 구멍이다.
              · 순위 자체를 모름    — 둘 중 뭔지 우리도 모른다. 모른다고 적는다.
            한 문장으로 뭉뚱그리면 예선에서 떨어진 사람이 데이터 결함처럼 보인다.
          */}
          {e.matches === 0 ? (
            <p className="tabular mt-2 text-[11px] text-ink-400">
              {e.placement_rank === 99
                ? "예선에서 탈락해 본선 경기가 없습니다."
                : e.placement_rank == null
                  ? "본선 경기 기록이 없습니다 — 예선에서 탈락했는지, 우리가 경기를 못 붙였는지는 확인하지 못했습니다."
                  : "명단에는 있으나 경기 기록을 붙이지 못했습니다 — 라이엇 계정을 확인하지 못한 참가자입니다."}
            </p>
          ) : (
            <p className="tabular mt-2 text-sm text-ink-300">
              매치 {e.match_wins}승
              {e.match_draws > 0 && ` ${e.match_draws}무`}
              {" "}{e.matches - e.match_wins - e.match_draws}패
              <span className="ml-3 text-[11px] text-ink-500">
                세트로는 {e.set_wins}승 {e.sets - e.set_wins}패
              </span>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 상대 전적 필터 — **정렬과 연도를 한 창에** 둔다.
 *
 * 둘은 처음부터 같이 걸렸지만(주소에 둘 다 남는다) 창이 둘로 나뉘어 있어서
 * 따로 노는 것처럼 보였다. 필터가 두 상자면 "이 둘이 같이 적용되나?" 를
 * 화면이 대답해 주지 못한다. 하나로 합치고, 지금 뭐가 걸려 있는지 아래 줄에 적는다.
 */
export function OpponentFilters({
  sort, years, year, hrefFor, total,
}: {
  sort: OpponentSort;
  years: number[];
  year?: number;
  hrefFor: HrefFor;
  total: number;
}) {
  const active = sort !== "games" || year !== undefined;
  const sortHint = OPPONENT_SORTS.find((o) => o.key === sort)?.hint;

  return (
    <div className="mb-3 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 shrink-0 text-[11px] text-ink-400">정렬</span>
        {OPPONENT_SORTS.map((o) => (
          <Link
            key={o.key}
            href={hrefFor({ sort: o.key })}
            scroll={false}
            title={o.hint}
            className={chip(sort === o.key)}
          >
            {o.label}
          </Link>
        ))}
      </div>

      {years.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="w-8 shrink-0 text-[11px] text-ink-400">연도</span>
          <Link href={hrefFor({ year: null })} scroll={false} className={chip(year === undefined)}>
            전체
          </Link>
          {years.map((y) => (
            <Link key={y} href={hrefFor({ year: y })} scroll={false} className={chip(year === y)}>
              {y}
            </Link>
          ))}
        </div>
      )}

      {/* 지금 뭐가 걸려 있는지 한 줄로 되읽어 준다. 칩 색만으로는 조합이 안 읽힌다. */}
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-ink-800 pt-2">
        <span className="text-[11px] text-ink-500">
          {year ? `${year}년 · ` : "전체 기간 · "}
          {sortHint} · 상대 <span className="tabular text-ink-300">{total}</span>명
        </span>
        {active && (
          <Link
            href={hrefFor({ sort: null, year: null })}
            scroll={false}
            className="text-[11px] text-ink-400 hover:text-accent-400"
          >
            필터 지우기
          </Link>
        )}
      </div>
    </div>
  );
}

/** 접힌 줄만 보고도 "누구를 몇 승 몇 패로" 가 보여야 접는 뜻이 있다. */
function OpponentHeadline({ r }: { r: OpponentRow }) {
  return (
    <span className="tabular text-[11px] text-ink-400">
      {r.vs_matches > 0 ? (
        <>
          맞대결 {r.vs_match_wins}승
          {r.vs_match_draws > 0 && ` ${r.vs_match_draws}무`}
          {" "}{r.vs_matches - r.vs_match_wins - r.vs_match_draws}패
        </>
      ) : (
        "맞대결 없음"
      )}
      {r.ally_matches > 0 && (
        <span className="ml-2 text-ink-500">
          · 같은 팀 {r.ally_match_wins}승{" "}
          {r.ally_matches - r.ally_match_wins - r.ally_match_draws}패
        </span>
      )}
    </span>
  );
}

/** 요약판용 — 펼치지 않는 한 줄. 경기 이력을 안 읽으므로 질의도 가볍다. */
export function OpponentRowCompact({ r, slug }: { r: OpponentRow; slug: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-2.5">
      <Link href={`/vs/${slug}/${r.slug}`} className="font-medium text-ink-200 hover:text-accent-400">
        vs {r.display_name}
      </Link>
      <OpponentHeadline r={r} />
      <span className="ml-auto text-[11px] text-ink-400">마지막 {relativeDate(r.last_met)}</span>
    </li>
  );
}

export function OpponentCard({
  r, slug, streamerName, vsRows, allyRows,
}: {
  r: OpponentRow;
  slug: string;
  streamerName: string;
  vsRows: OpponentGame[];
  allyRows: OpponentGame[];
}) {
  return (
    <li className="rounded-xl border border-ink-800 bg-ink-900/60">
      {/*
        ★ 접어 둔다. 상대가 수십 명이면 다 펴 놓은 목록은 못 읽는다.
          요약 줄에는 링크를 넣지 않는다 — 누르면 펼침과 이동이 겹친다.
      */}
      <details className="group">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-ink-800/30">
          <span className="text-ink-500 transition-transform group-open:rotate-90">›</span>
          <span className="font-medium text-ink-200">vs {r.display_name}</span>
          <OpponentHeadline r={r} />
          <span className="ml-auto text-[11px] text-ink-400">마지막 {relativeDate(r.last_met)}</span>
        </summary>

        <div className="px-4 pb-3">
          <Link
            href={`/vs/${slug}/${r.slug}`}
            className="text-[11px] text-ink-400 hover:text-accent-400"
          >
            {streamerName} vs {r.display_name} 상대전적 페이지 →
          </Link>

          {/*
            ★ 두 블록을 시각적으로 가른다. 같은 팀 승리를 상대전적에 섞으면
              '이겼다' 의 뜻이 달라진다 — 하나는 그 사람을 이긴 것이고
              다른 하나는 그 사람과 같이 이긴 것이다.
          */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-rose-500/25 bg-rose-500/[0.04] p-3">
              <div className="mb-2 text-[11px] font-medium text-rose-300/90">맞붙었을 때</div>
              {r.vs_matches === 0 ? (
                <p className="text-[11px] text-ink-400">상대편으로 만난 적이 없습니다.</p>
              ) : (
                <>
                  <div className="mb-1 text-[11px] text-ink-400">
                    팀 상대전적 <span className="text-ink-500">· 상대편에 있었던 전부</span>
                  </div>
                  <DualRecord
                    label="상대"
                    match={{
                      wins: r.vs_match_wins,
                      draws: r.vs_match_draws,
                      losses: r.vs_matches - r.vs_match_wins - r.vs_match_draws,
                    }}
                    set={{ wins: r.vs_set_wins, losses: r.vs_sets - r.vs_set_wins }}
                  />
                  {r.lane_matches > 0 && (
                    <div className="mt-3 border-t border-ink-800 pt-3">
                      <div className="mb-1 text-[11px] text-ink-400">
                        1:1 맞라인 <span className="text-ink-500">· 같은 라인끼리만</span>
                      </div>
                      <DualRecord
                        label="맞라인"
                        match={{
                          wins: r.lane_match_wins,
                          draws: r.lane_match_draws,
                          losses: r.lane_matches - r.lane_match_wins - r.lane_match_draws,
                        }}
                        set={{ wins: r.lane_set_wins, losses: r.lane_sets - r.lane_set_wins }}
                      />
                    </div>
                  )}
                  <SeriesLog games={vsRows} label="맞붙은" />
                </>
              )}
            </div>

            <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.04] p-3">
              <div className="mb-2 text-[11px] font-medium text-sky-300/90">같은 팀이었을 때</div>
              {r.ally_matches === 0 ? (
                <p className="text-[11px] text-ink-400">같은 팀이었던 적이 없습니다.</p>
              ) : (
                <>
                  <div className="mb-1 text-[11px] text-ink-400">
                    함께 뛴 승률 <span className="text-ink-500">· 같이 이긴 것</span>
                  </div>
                  <DualRecord
                    label="같은 팀"
                    match={{
                      wins: r.ally_match_wins,
                      draws: r.ally_match_draws,
                      losses: r.ally_matches - r.ally_match_wins - r.ally_match_draws,
                    }}
                    set={{ wins: r.ally_set_wins, losses: r.ally_sets - r.ally_set_wins }}
                  />
                  <SeriesLog games={allyRows} label="같은 팀으로" />
                </>
              )}
            </div>
          </div>
        </div>
      </details>
    </li>
  );
}

export function ChampionList({ champions }: { champions: ChampionRow[] }) {
  if (champions.length === 0) return <EmptyLine>아직 집계된 챔피언이 없습니다.</EmptyLine>;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {champions.map((c) => (
        <li key={c.champion_id} className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-ink-200">{c.champion_name ?? `챔피언 ${c.champion_id}`}</span>
            <Kda
              k={Math.round(c.kills / c.games)}
              d={Math.round(c.deaths / c.games)}
              a={Math.round(c.assists / c.games)}
            />
          </div>
          <div className="mt-2">
            <RecordBar record={{ wins: c.wins, losses: c.games - c.wins }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function GameList({ games }: { games: RecentGame[] }) {
  if (games.length === 0) return <EmptyLine>아직 수집된 경기가 없습니다.</EmptyLine>;
  return (
    <ul className="divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/60">
      {games.map((g) => (
        <li key={g.match_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <WinPill win={g.win} />
          <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
            {g.champion_name ?? `챔피언 ${g.champion_id}`}
          </span>
          <PositionTag position={g.team_position} />
          <Kda k={g.kills} d={g.deaths} a={g.assists} />
          <span className="tabular text-[11px] text-ink-400">CS {g.cs ?? "—"}</span>
          <QueueTag queueId={g.queue_id} />
          <span className="text-[11px] text-ink-400">{relativeDate(g.game_creation)}</span>
        </li>
      ))}
    </ul>
  );
}
