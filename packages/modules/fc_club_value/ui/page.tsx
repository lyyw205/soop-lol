/** FC 구단가치: 스트리머 순위·가치 차트·선수 선택을 한 화면에서 제공한다.
 * 선택은 ?s=스트리머&p=카드,카드 로 유지한다. */
import Link from "next/link";
import { cache } from "react";
import { Avatar } from "../../../ui/avatar.tsx";
import {
  cardKey, changeOver, formatWon, fcoMetadata, getFcoClub, listFcoClubBoard, profileHref,
  type FcoClub, type FcoClubAccountSummary, type FcoClubBoardRow,
} from "@soop-lol/core/lib/contract";
import { clubBoardHref } from "./paths.ts";
import { ClubValueChart, type ChartPlayer, type ChartPoint } from "./value-chart.tsx";
import { ComparisonPicker } from "./comparison-picker.tsx";
import { RankingTable } from "./ranking-table.tsx";
import { TeamColorIcons } from "./team-color-icons.tsx";
import { quotedPrices } from "./price-history.ts";
import { MAX_PLAYERS, PLAYER_COLORS } from "./comparison-config.ts";
import "./club-value.css";

type Props = {
  params: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
};

const loadClub = cache((slug: string) => getFcoClub(slug));
const first = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v;

export function generateMetadata() {
  return { title: "구단가치" };
}

export default async function FcClubValue({ searchParams }: Props) {
  return <Board searchParams={searchParams} />;
}

// ── 선택 상태(주소) ──────────────────────────────────────────────────

/** 주소의 p= 를 이 구단에 실제로 있고 시세가 있는 카드만 남겨 읽는다(순서 유지, 최대 20). */
function pickedCards(club: FcoClub, raw: string | undefined): string[] {
  const keys = (raw ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return [...new Set(keys)].filter((k) => quotedPrices(club.cardSeries[k] ?? []).length > 0).slice(0, MAX_PLAYERS);
}

/** 선택 주소를 만든다. 스트리머가 바뀌면 선수 선택은 버린다(그 구단의 선수가 아니다). */
type HrefFor = (state: { slug: string; picks: string[] }) => string;
const boardHrefFor: HrefFor = ({ slug, picks }) => {
  const q = new URLSearchParams({ s: slug });
  if (picks.length) q.set("p", picks.join(","));
  return `${clubBoardHref()}?${q}`;
};

const toggle = (picks: string[], key: string) => picks.includes(key) ? picks.filter((k) => k !== key) : [...picks, key];

/** 차트는 클라이언트라 계약을 못 부른다 — 금액 문자열을 여기서 붙여 넘긴다. */
const withLabel = (points: { day: string; value: number; missing?: number }[]): ChartPoint[] =>
  points.map((p) => ({ day: p.day, value: p.value, label: formatWon(p.value), missing: p.missing ?? 0 }));

// ── 표시 조각 ────────────────────────────────────────────────────────

function Won({ value }: { value: number | null }) {
  if (value === null) return <span className="cv-muted">—</span>;
  return <span title={`${value.toLocaleString("ko-KR")}원`}>{formatWon(value)}</span>;
}

/** 등락. 오르면 빨강 ▲, 내리면 파랑 ▼(국내 시세 관례) — 색만으로 구분하지 않는다. 기록이 모자라면 모른다고 쓴다. */
function Change({ series, days }: { series: { day: string; value: number }[] | undefined; days: number }) {
  const c = series ? changeOver(series, days) : null;
  if (!c) return <span className="cv-muted" title={`${days}일 전 기록이 아직 없다`}>—</span>;
  const dir = c.delta > 0 ? "up" : c.delta < 0 ? "down" : "flat";
  const mark = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
  return <span className={`cv-change cv-${dir}`} title={`${c.since} 대비 ${c.delta > 0 ? "+" : ""}${formatWon(c.delta)}`}>
    {mark} {Math.abs(c.pct).toFixed(c.pct !== 0 && Math.abs(c.pct) < 0.1 ? 2 : 1)}%
  </span>;
}

const kst = (iso: string | null) => iso
  ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—";

const statusText = (a: FcoClubAccountSummary) =>
  a.status === "missing" ? `구단주 검색에서 "${a.nickname}" 을 찾지 못했다(감독명이 바뀌었을 수 있다)`
    : a.status === null ? "아직 조회하지 않았다" : "공식 구단가치를 받지 못했다";

// ── 차트 패널 ────────────────────────────────────────

async function ClubPanel({ club, picks, hrefFor }: {
  club: FcoClub; picks: string[]; hrefFor: HrefFor;
}) {
  const { account } = club;
  const { seasons } = await fcoMetadata();
  const byKey = new Map(club.holdings.map((c) => [cardKey(c), c]));
  const players: ChartPlayer[] = picks.map((key, i) => ({
    key,
    name: byKey.get(key)?.name ?? key,
    color: PLAYER_COLORS[i],
    points: withLabel(quotedPrices(club.cardSeries[key] ?? [])),
    removeHref: hrefFor({ slug: club.slug, picks: picks.filter((k) => k !== key) }),
  }));
  return <section className="cv-panel" aria-label={`${club.name} 구단 가치`}>
    {account.club_value === null && <div className="fc-empty">{statusText(account)}</div>}
    <div className="cv-comparison">
      <ClubValueChart clubName={club.name} estimatedHistory={withLabel(quotedPrices(club.backcast))} collectedHistory={withLabel(quotedPrices(club.actual))} players={players} summary={
    <div className="cv-chart-summary">
      <div className="cv-figures">
        <div className="cv-figure">
          <span className="cv-label">총 구단가치</span>
          <strong className="cv-hero">{account.club_value === null ? "—" : <Won value={account.club_value} />}</strong>
        </div>
      </div>
    </div>
      } />
      <ComparisonPicker slug={club.slug} count={picks.length} players={[...club.holdings].sort((a, b) => (b.price ?? -1) - (a.price ?? -1)).map(c => {
        const key = cardKey(c);
        const selected = picks.includes(key);
        return { key, name: c.name, season: c.season ?? "", seasonIcon: seasons.get(Math.floor(c.spid / 1_000_000))?.icon ?? null, meta: [c.season, c.grade === null ? "강화 미확인" : `+${c.grade}`].filter(Boolean).join(" · "),
          price: c.price === null ? "—" : formatWon(c.price),
          exactPrice: c.price === null ? undefined : c.price.toLocaleString("ko-KR"),
          grade: c.grade, ovr: c.ovr, change7: changeOver(quotedPrices(club.cardSeries[key] ?? []), 7), selected, available: quotedPrices(club.cardSeries[key] ?? []).length > 0,
          color: selected ? PLAYER_COLORS[picks.indexOf(key)] : undefined,
          href: hrefFor({ slug: club.slug, picks: toggle(picks, key) }) };
      })} />
    </div>
    <div className="cv-panel-links">
      <Link href={profileHref("fconline", club.slug)}>FC 기록 →</Link>
    </div>
  </section>;
}

// ── 순위 ─────────────────────────────────────────────────────────────

/** 공식 구단가치 큰 순. 값을 못 받은 사람은 순위 없이 아래로 — 0원으로 섞지 않는다. */
const byValue = (a: FcoClubBoardRow, b: FcoClubBoardRow) =>
  (b.account.club_value ?? -1) - (a.account.club_value ?? -1) || a.name.localeCompare(b.name, "ko");

async function Board({ searchParams }: { searchParams: Props["searchParams"] }) {
  const rows = (await listFcoClubBoard()).sort(byValue);
  const ranked = rows.filter((r) => r.account.club_value !== null);
  const latest = rows.map((r) => r.account.captured_at).filter(Boolean).sort().at(-1) ?? null;
  // 고른 사람이 없거나 목록에 없으면 1위를 보여 준다.
  const selected = rows.find((r) => r.slug === first(searchParams.s)) ?? ranked[0] ?? rows[0];
  const club = selected ? await loadClub(selected.slug) : null;
  const picks = club ? pickedCards(club, first(searchParams.p)) : [];

  return <div className="arena-workspace record-workspace cv-workspace"><div className="record-main cv-main">
    <h1 className="cv-sr-only">구단가치</h1>
    <div className="cv-dashboard">
      <section className="cv-streamers" aria-label="스트리머 구단가치 순위">
        <h2>스트리머 순위 <small>등락률 · 7일 기준</small></h2>
        <div className="cv-streamer-grid" tabIndex={0} aria-label="스트리머 순위표">
        <RankingTable items={rows.map(row => {
            const rank = ranked.indexOf(row) + 1;
            return { id: row.id, rank: rank || null, value: row.account.club_value,
              officialRank: row.account.officialRank?.rank ?? null, rating: row.account.rating?.currentGrade?.order ?? null, previousBest: row.account.rating?.previousBestGrade?.order ?? null,
              content: <Link key={row.id} href={boardHrefFor({ slug: row.slug, picks: [] })} scroll={false}
              className="cv-streamer-card" aria-current={row.id === selected?.id ? "true" : undefined}>
              <span className="cv-rank" data-rank={rank}>{rank || "—"}</span>
              <span className="cv-official-rank" title={row.account.officialRank
                ? `${row.account.officialRank.day} 기준 · ${row.account.officialRank.rank === null ? "공식 TOP 50에 없음(집계 제외 여부 미확인)" : "넥슨 공식 구단가치 순위"}`
                : "공식 구단가치 순위 미조회"}>{row.account.officialRank?.rank ? `${row.account.officialRank.rank}위` : "—"}</span>
              <span className="cv-streamer-identity" title={row.name}><Avatar name={row.name} src={row.image} channelId={row.channel_id} /><strong>{row.name}</strong></span>
              <span className="cv-streamer-owner" title={row.account.nickname}>{row.account.nickname}</span>
              <span className="cv-streamer-team"><TeamColorIcons observation={row.account.teamColors} /></span>
              <span className="cv-streamer-value"><strong><Won value={row.account.club_value} /></strong></span>
              <span className="cv-streamer-change"><Change series={row.account.history} days={7} /></span>

              <span className="cv-rating cv-division-cell" title={row.account.rating
                ? `현재 시즌 1대1 · 등급 ${kst(row.account.rating.gradesCheckedAt)} 조회`
                : "공식경기 미조회"}>
                {row.account.rating?.currentGrade && <span className="cv-division"><img src={row.account.rating.currentGrade.icon} alt="" width={38} height={38} /><span>{row.account.rating.currentGrade.name}</span></span>}
                {!row.account.rating?.currentGrade && "—"}
              </span>
              <span className="cv-previous-best cv-division-cell" title={`직전 시즌 1대1 최고등급 · ${kst(row.account.rating?.gradesCheckedAt ?? null)} 조회`}>
                {row.account.rating?.previousBestGrade ? <span className="cv-division"><img src={row.account.rating.previousBestGrade.icon} alt="" width={38} height={38} /><span>{row.account.rating.previousBestGrade.name}</span></span> : "—"}
              </span>
            </Link> };
          })} />
        </div>
        <p className="cv-source">마지막 확인 {kst(latest)} · 기록은 하루 한 번 쌓입니다.</p>
      </section>
      <div className="cv-dashboard-main">
        {club && <>
          <ClubPanel club={club} picks={picks} hrefFor={boardHrefFor} />
        </>}
      </div>
    </div>
  </div></div>;
}
