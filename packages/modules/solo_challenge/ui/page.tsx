/**
 * 솔랭 도전 화면. host 가 등록부의 경로(/lol/challenges, /lol/challenges/[slug])를 보고 여기를 띄운다.
 * 틀(nav·본문 폭)은 host 가 씌운다 — 여기는 내용만 그린다. 거르기는 주소(?f=)로 한다(클라이언트 상태 없음).
 * 도전 현황 → 승패 흐름 → 기록실 → 챔피언 → 판별 기록. 데이터 계산은 서버 모델이 맡는다.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowUpRight, ChevronRight, Users } from "lucide-react";

import {
  championById, championIconPath, profileHref, kstDateString,
} from "@soop-lol/core/lib/contract";

import {
  getChallenge, listChallenges, progressAt,
  type ChallengeView, type ChampRow, type GameRow, type MemberLine,
} from "../server/index.ts";
import { challengeHref, challengesHref } from "./paths.ts";
import { ShowMore } from "./show-more.tsx";
import { ChallengeTabs } from "./tabs.tsx";
import { GameCard } from "./match-card.tsx";
import "./challenge.css";
import { FlowChart } from "./flow-chart.tsx";
import { RecordCards } from "./record-cards.tsx";

type Props = { params?: Record<string, string>; searchParams: Record<string, string | string[] | undefined> };

const load = cache(getChallenge);

export async function generateMetadata({ params }: Props) {
  if (!params?.slug) return { title: "솔랭 도전" };
  return { title: (await load(params.slug))?.def.title ?? "솔랭 도전" };
}

const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"] as const;
const TIER_KO: Record<string, string> = {
  IRON: "아이언", BRONZE: "브론즈", SILVER: "실버", GOLD: "골드", PLATINUM: "플래티넘", EMERALD: "에메랄드",
  DIAMOND: "다이아몬드", MASTER: "마스터", GRANDMASTER: "그랜드마스터", CHALLENGER: "챌린저",
};
const APEX = ["MASTER", "GRANDMASTER", "CHALLENGER"];
const rankText = (tier: string | null | undefined, division: string | null | undefined, lp: number | null | undefined) =>
  tier ? `${TIER_KO[tier] ?? tier}${division && !APEX.includes(tier) ? ` ${division}` : ""} ${lp ?? 0}LP` : "랭크 기록 없음";
const tierAt = (abs: number) => TIER_KO[TIERS[Math.floor(abs / 400)]] ?? "";
const pct = (v: number) => `${Math.round(v * 100)}%`;
const colorVars = (v: ChallengeView) => Object.fromEntries(v.def.members.map((m, i) => [`--sc-m${i}`, `var(--sc-${m.color})`])) as React.CSSProperties;

const dayText = (day: string) => `${Number(day.slice(5, 7))}.${day.slice(8)}`;

export default async function SoloChallengePage({ params, searchParams }: Props) {
  if (!params?.slug) {
    const all = await listChallenges();
    return (
      <div className="sc-page">
        <header className="sc-head"><span className="sc-eyebrow">솔로랭크</span><h1>솔랭 도전</h1>
          <p className="sc-muted">스트리머들이 목표 티어를 정하고 솔로랭크를 올리는 도전을 모았습니다.</p></header>
        <div className="sc-list">
          {all.map((v) => (
            <Link key={v.def.slug} href={challengeHref(v.def.slug)} className="sc-card" style={colorVars(v)}>
              <b>{v.def.title}</b>
              <span className="sc-muted">{v.def.summary}</span>
              <Progress view={v} compact />
            </Link>
          ))}
        </div>
      </div>
    );
  }
  const v = await load(params.slug);
  if (!v) notFound();
  const requestedFilter = typeof searchParams.f === "string" ? searchParams.f : "all";
  const f = ["all", "w", "l", "solo"].includes(requestedFilter) ? requestedFilter : "all";
  const tabIds = ["now", "rec", "champ", "games"];
  const requestedTab = typeof searchParams.tab === "string" ? searchParams.tab : searchParams.f ? "games" : "now";
  const tab = requestedTab === "flow" ? "now" : tabIds.includes(requestedTab) ? requestedTab : "now";
  const tabHref = (id: string) => challengeHref(v.def.slug, { tab: id, ...(f !== "all" ? { f } : {}) });
  // Calendar days in KST; the start date is D+0.
  const challengeDays = Math.max(0, Math.round((Date.parse(kstDateString(new Date()) + "T00:00:00Z") - Date.parse(v.def.since + "T00:00:00Z")) / 86_400_000));
  const winRate = v.record.games ? (v.record.wins / v.record.games * 100).toFixed(1) : "0.0";
  const visibleGames = [...v.games].reverse().filter((g) => keep(g, f));
  return (
    <div className="sc-page sc-detail" style={colorVars(v)}>
      <div className="sc-breadcrumb"><Link href={challengesHref()}><ArrowLeft size={14} /> 솔랭 도전</Link><ChevronRight size={12} /><span>{v.def.title}</span></div>
      <header className={`sc-hero${v.def.heroImage ? " sc-hero-has-image" : ""}`}>
        <div className="sc-hero-bg" aria-hidden="true">{v.def.heroImage && <img src={v.def.heroImage} alt="" />}</div>
        <div className="sc-hero-scrim" aria-hidden="true" />
        <div className="sc-hero-body">
          <div className="sc-hero-copy">
            <span className="sc-eyebrow"><span /> DUO CHALLENGE <i /> {v.def.since.replaceAll("-", ".")} START</span>
            <h1>{v.def.title.includes(" 마스터 도전") ? <>{v.def.title.replace(" 마스터 도전", "")}<br /><em>마스터</em> 도전<span className="sc-title-period">.</span></> : v.def.title}</h1>
            <p>{v.def.summary}</p>
            <div className="sc-hero-actions">
              <Link href={tabHref("games")} scroll={false} className="sc-hero-link">도전의 모든 경기 <ArrowDown size={15} /></Link>
              <div className="sc-hero-members"><span className="sc-hero-avatars">{v.def.members.map((m) => ["seokwngud", "kimmingyo"].includes(m.streamer)
                ? <img key={m.streamer} src={`/images/challenge-members/${m.streamer}.jpg`} alt="" width={28} height={28} />
                : <span key={m.streamer} className="sc-hero-initial" aria-hidden="true">{m.name.slice(0, 1)}</span>)}</span><span>{v.def.members.map((m) => m.name).join(" · ")}</span></div>
            </div>
          </div>
          <div className="sc-goal-chip" aria-label={`목표 ${TIER_KO[v.def.goal.tier] ?? v.def.goal.tier}`}>
            <RankEmblem tier={v.def.goal.tier} /><span><small>GOAL</small><strong>{v.def.goal.tier}</strong></span>
          </div>
        </div>
        <div className="sc-hero-stats">
          <div><span>진행</span><strong>D+{challengeDays}<small>일째</small></strong></div>
          <div><span>수집된 경기</span><strong>{v.record.games}<small>판</small></strong></div>
          <div><span className="sc-hero-record-label">도전 전적<b>승률 {winRate}%</b></span><strong className="sc-hero-record-value"><b className="sc-w">{v.record.wins}<small>승</small></b><b className="sc-l">{v.record.games - v.record.wins}<small>패</small></b></strong></div>
          <div><span>최장 연승</span><strong>{v.record.bestWinStreak}<small>연승</small></strong></div>
        </div>
      </header>
      <ChallengeTabs active={tab} tabs={[
        { id: "now", label: "도전 현황", href: tabHref("now") },
        { id: "rec", label: "기록실", href: tabHref("rec") },
        { id: "champ", label: "챔피언", href: tabHref("champ") },
        { id: "games", label: "판별 기록", href: tabHref("games"), count: v.games.length },
      ]} />
      <div className="sc-tab-panel" role="tabpanel" id={`sc-panel-${tab}`} aria-labelledby={`sc-tab-${tab}`} tabIndex={0}>

      {tab === "now" && (
      <section aria-labelledby="sc-now">
        <SectionHeading id="sc-now" index="01" title="도전 현황" />
        <Progress view={v} />
        <p className="sc-note">지금 랭크는 하루 한 번 찍는 스냅샷({v.members.map((m) => m.rank?.date).filter(Boolean)[0] ?? "기록 없음"}) 기준, 출발점은 방송 화면에서 확인한 값입니다. Riot 은 과거 랭크를 주지 않습니다.</p>
      </section>
      )}

      {tab === "now" && (
      <section aria-labelledby="sc-flow">
        <h2 id="sc-flow">승패 흐름</h2>
        <Streaks view={v} />
      </section>
      )}

      {tab === "rec" && (
      <section aria-labelledby="sc-rec">
        <SectionHeading id="sc-rec" index="02" title="기록실" />
        <RecordCards view={v} />
        <p className="sc-note">이 도전의 판만 셉니다. 다시하기(5분 미만)는 빼고 셉니다.</p>
      </section>
      )}

      {tab === "champ" && (
      <section aria-labelledby="sc-champ">
        <SectionHeading id="sc-champ" index="03" title="챔피언" />
        <div className="sc-grid">
          {v.stats.map((s, i) => <ChampTable key={i} view={v} i={i} rows={s.champs} />)}
        </div>
        <p className="sc-note">승률은 판 수가 적으면 50%쪽으로 당긴 값입니다(4판을 반반으로 더함). 3승 0패를 "승률 100%"로 쓰지 않습니다.</p>
      </section>
      )}

      {tab === "now" && v.coPlayers.length > 0 && (
        <section aria-labelledby="sc-met">
          <div className="sc-section-heading"><h2 id="sc-met"><Users size={19} /> 솔랭에서 만난 스트리머</h2><span>도전 중 마주친 익숙한 이름들</span></div>
          <div className="sc-panel sc-met">
            {v.coPlayers.slice(0, 16).map((c) => (
              <Link key={c.slug} href={profileHref("lol", c.slug)} className="sc-chip">
                <span className="sc-chip-avatar">{c.name.slice(0, 1)}</span><span><b>{c.name}</b><span className="sc-muted">같은 팀 {c.ally} · 상대 {c.enemy}</span></span><ArrowUpRight size={14} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {tab === "games" && (
      <section aria-labelledby="sc-games">
        <SectionHeading id="sc-games" index="04" title="판별 기록" subtitle="최신 경기부터 · 경기를 누르면 상세 기록이 펼쳐집니다" />
        <nav className="sc-filters" aria-label="거르기">
          {[["all", "전체"], ["w", "이긴 판"], ["l", "진 판"], ["solo", "솔킬 3+ 판"]].map(([k, label]) => (
            <Link key={k} href={challengeHref(v.def.slug, { tab: "games", ...(k === "all" ? {} : { f: k }) })} aria-current={f === k ? "true" : undefined} scroll={false}>{label}<span>{v.games.filter((g) => keep(g, k)).length}</span></Link>
          ))}
        </nav>
        <ShowMore key={f} step={10} gameIds={visibleGames.map((g) => `g-${g.matchId}`)}>
          {visibleGames.map((g) => <GameCard key={g.matchId} view={v} g={g} />)}
        </ShowMore>
        {v.riotGames != null && v.riotGames > v.record.games && (
          <p className="sc-note">Riot 기준 시즌 {v.riotGames}판 중 {v.record.games}판이 수집됐습니다. 나머지는 수집되는 대로 늘어납니다.</p>
        )}
      </section>
      )}
      </div>
    </div>
  );
}

function SectionHeading({ id, index, title, subtitle }: { id: string; index: string; title: string; subtitle?: string }) {
  return <div className="sc-section-heading"><div><span className="sc-section-index">{index}</span><h2 id={id}>{title}</h2></div>{subtitle && <span>{subtitle}</span>}</div>;
}

function keep(g: GameRow, f: string): boolean {
  if (f === "w") return g.win;
  if (f === "l") return !g.win;
  if (f === "solo") return g.lines.some((l) => (l?.soloKills ?? 0) >= 3);
  return true;
}

function RankEmblem({ tier, small = false }: { tier?: string | null; small?: boolean }) {
  if (!tier || !TIER_KO[tier]) return null;
  return <span className={`sc-rank-emblem${small ? " small" : ""}`}><img src={`/images/ranked-emblems/${tier.toLowerCase()}.png`} alt={`${TIER_KO[tier]} 티어`} width={1280} height={720} /></span>;
}

function ChallengerCard({ m, index, goal }: { m: MemberLine; index: number; goal: string }) {
  const hasPortrait = ["seokwngud", "kimmingyo"].includes(m.member.streamer);
  return <article className="sc-challenger" style={{ "--player": `var(--sc-m${index})` } as React.CSSProperties}>
    <div className="sc-challenger-main">
      <div className="sc-challenger-identity">
        <Link className="sc-challenger-profile" href={profileHref("lol", m.member.streamer)}>
          {hasPortrait ? <img className="sc-challenger-avatar" src={`/images/challenge-members/${m.member.streamer}.jpg`} alt="" width={44} height={44} /> : <span className="sc-challenger-avatar sc-challenger-initial">{m.member.name.slice(0, 1)}</span>}
          <span><strong>{m.member.name}</strong><small>{m.member.role} · 도전 계정</small></span>
        </Link>
    <dl className="sc-challenger-metrics">
      <div><dt>출발 후 {m.gained != null && m.gained < 0 ? "변동" : "상승"}</dt><dd>{m.gained != null ? <>{m.gained >= 0 ? "+" : ""}{m.gained.toLocaleString("ko-KR")} <small>LP</small></> : "기록 없음"}</dd></div>
      <div><dt>{goal}까지</dt><dd>{m.toGoal == null ? "기록 없음" : m.toGoal === 0 ? "목표 달성" : <>{m.toGoal.toLocaleString("ko-KR")} <small>LP</small></>}</dd></div>
    </dl>
      </div>
      <div className="sc-challenger-rank"><RankEmblem tier={m.rank?.tier} /><span className="sc-challenger-rankline"><span>{m.rank?.tier ? `${TIER_KO[m.rank.tier] ?? m.rank.tier}${m.rank.division && !APEX.includes(m.rank.tier) ? ` ${m.rank.division}` : ""}` : "랭크 기록 없음"}</span><i aria-hidden="true">|</i><span>{m.rank?.lp != null ? <><b>{m.rank.lp}</b> LP</> : "LP 기록 없음"}</span></span></div>
    </div>


  </article>;
}

/* 두 멤버를 공통 티어 축에 표시한다. 랭크 스냅샷을 승패 시계열과 혼동하지 않는다. */
function Progress({ view, compact = false }: { view: ChallengeView; compact?: boolean }) {
  const at = (abs: number) => progressAt(abs, view.floorAbs, view.goalAbs);
  const majors: number[] = [];
  for (let t = Math.ceil(view.floorAbs / 400) * 400; t < view.goalAbs; t += 400) majors.push(t);
  if (!compact) return (
    <div className="sc-shared-progress">
      <div className="sc-shared-key"><span>○ 출발 <i /> ● 현재</span><span className="sc-shared-goal">공동 목표 <RankEmblem tier={view.def.goal.tier} small /><b>{TIER_KO[view.def.goal.tier] ?? view.def.goal.tier}</b></span></div>
      <div className="sc-challengers">{view.members.map((m, i) => <ChallengerCard key={m.member.streamer} m={m} index={i} goal={TIER_KO[view.def.goal.tier] ?? view.def.goal.tier} />)}</div>
      <div className="sc-shared-chart" role="img" aria-label={view.members.map((m) => `${m.member.name}: ${rankText(m.rank?.tier, m.rank?.division, m.rank?.lp)}, 목표까지 ${m.toGoal ?? "알 수 없음"}LP`).join(". ")}>
        <div className="sc-shared-axis">
          {majors.map((t) => <span key={t} style={{ left: `${at(t)}%` }}><span className="sc-axis-full">{tierAt(t)}</span><span className="sc-axis-short">{tierAt(t).replace("플래티넘", "플래").replace("에메랄드", "에메").replace("다이아몬드", "다이아")}</span></span>)}
          <b style={{ left: "100%" }}><span>{TIER_KO[view.def.goal.tier] ?? view.def.goal.tier}</span></b>
        </div>
        <div className="sc-shared-bar" aria-hidden="true">
          {majors.map((t, i) => <span key={t} className="sc-tier-segment" data-active={view.members.some((m) => m.rank?.abs != null && m.rank.abs >= t && m.rank.abs < (majors[i + 1] ?? view.goalAbs)) || undefined} style={{ left: `${at(t)}%`, width: `${at(majors[i + 1] ?? view.goalAbs) - at(t)}%`, background: ["#6c7584", "#9b7151", "#8593a3", "#b69a5e", "#459b99", "#3e9d77", "#627fb9"][Math.floor(t / 400)] ?? "#9c6dbf" }} />)}
          {view.members.map((m, i) => {
            const current = m.rank?.abs == null ? null : at(m.rank.abs);
            const start = m.startAbs == null ? null : at(m.startAbs);
            return <span key={m.member.streamer} className={`sc-bar-member ${i % 2 ? "below" : "above"}`} style={{ "--player": `var(--sc-m${i})` } as React.CSSProperties}>
              {start != null && <span className="sc-bar-start" style={{ left: `${start}%` }} title={`${m.member.name} 출발`} />}
              {current != null && <span className="sc-bar-current" style={{ left: `${current}%` }} />}
            </span>;
          })}
        </div>
        {view.members.map((m, i) => {
          const current = m.rank?.abs == null ? null : at(m.rank.abs);
          return <div key={m.member.streamer} className={`sc-bar-label ${i % 2 ? "below" : "above"}`} style={{ "--player": `var(--sc-m${i})`, "--current": `${current ?? 50}%`, left: `clamp(0px, calc(${current ?? 50}% - 72px), calc(100% - 144px))` } as React.CSSProperties}>
            <strong><i aria-hidden="true" />{m.member.name}</strong>
          </div>;
        })}
      </div>

    </div>
  );
  return (
    <div className="sc-progress">
      <div className="sc-ptrack" role="img"
        aria-label={view.members.map((m) => `${m.member.name}: ${m.member.start ? `출발 ${rankText(m.member.start.tier, m.member.start.division, m.member.start.lp)}, ` : ""}지금 ${rankText(m.rank?.tier, m.rank?.division, m.rank?.lp)}, 목표까지 ${m.toGoal ?? "?"}LP`).join(" · ")}>
        {majors.map((t) => <span key={t} className="sc-pmajor" style={{ left: `${at(t)}%` }} />)}
        {view.members.map((m: MemberLine, i) => (
          <span key={i}>
            {m.startAbs != null && <span className="sc-pstart" style={{ left: `${at(m.startAbs)}%`, borderColor: `var(--sc-m${i})` }} title={`${m.member.name} 출발`} />}
            {m.rank?.abs != null && <span className="sc-pnow" style={{ left: `${at(m.rank.abs)}%`, background: `var(--sc-m${i})` }} title={`${m.member.name} 지금`} />}
          </span>
        ))}
      </div>
      <div className="sc-pticks" aria-hidden="true">
        {majors.map((t) => <span key={t} style={{ left: `${at(t)}%` }}>{tierAt(t)}</span>)}
        <span className="goal" style={{ left: "100%" }}>{TIER_KO[view.def.goal.tier] ?? view.def.goal.tier}</span>
      </div>
      <div className="sc-plegend">
        {view.members.map((m, i) => (
          <div key={i} className="sc-ptext">
            <span className="sc-who"><span className="sc-dot" style={{ background: `var(--sc-m${i})` }} />{m.member.name}</span>
            <b className="sc-num">{rankText(m.rank?.tier, m.rank?.division, m.rank?.lp)}</b>
            <span className="sc-muted sc-small">
              {m.gained != null ? <><b className="sc-num" style={{ color: `var(--sc-m${i})` }}>{m.gained >= 0 ? "+" : ""}{m.gained}LP</b> 왔음 · </> : <>출발 기록 없음 · </>}
              {m.toGoal == null ? "목표까지 기록 없음" : m.toGoal > 0 ? <><b className="sc-num">{m.toGoal}</b>LP 남음</> : "목표 달성"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 승패 흐름: 누적(승−패) 선. 날짜마다 띠(번갈아 칠함)와 굵은 경계선, 띠 위쪽에 날짜·그날 승패 ──
 *   날짜마다 폭은 판 수에 비례하되 최소 폭을 줘서, 두 판뿐인 날도 글자가 겹치지 않게 한다. */
function Streaks({ view }: { view: ChallengeView }) {
  return <FlowChart flow={view.flow} days={view.days} record={view.record} />;
}

/* ── 챔피언 표(전적 사이트 형식) ── */
function ChampTable({ view, i, rows }: { view: ChallengeView; i: number; rows: ChampRow[] }) {
  const m = view.def.members[i];
  return (
    <div className="sc-tablewrap">
      <table className="sc-table sc-champtable">
        <caption><div className="sc-table-heading"><span className="sc-dot" style={{ background: `var(--sc-m${i})` }} /><strong>{m.name}</strong><span className="sc-muted">{m.role}</span><span className="sc-table-total">{view.stats[i].games}판 · {rows.length}챔피언</span></div></caption>
        <thead><tr><th>챔피언</th><th>판</th><th>승률</th><th>KDA</th><th>CS</th><th>딜/분</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} className="sc-empty">아직 챔피언 기록이 없습니다.</td></tr>}
          {rows.slice(0, 10).map((c) => {
            const champ = championById(c.id);
            return (
              <tr key={c.id}>
                <td><span className="sc-champcell">{champ && <img src={championIconPath(champ)} alt="" width={28} height={28} />}{c.name}</span></td>
                <td className="sc-num">{c.games}</td>
                <td className="sc-num"><div className="sc-rate"><b className={c.shrunk >= 0.5 ? "sc-w" : "sc-l"}>{pct(c.shrunk)}</b><span className="sc-faint">{c.wins}승 {c.losses}패</span><span className="sc-rate-track"><span style={{ width: pct(c.shrunk) }} /></span></div></td>
                <td className="sc-num"><b>{c.kda.toFixed(2)}</b> <span className="sc-table-sub sc-faint">{(c.kills / c.games).toFixed(1)}/{(c.deaths / c.games).toFixed(1)}/{(c.assists / c.games).toFixed(1)}</span></td>
                <td className="sc-num">{c.csPerMin.toFixed(1)}/분</td>
                <td className="sc-num">{Math.round(c.dmgPerMin).toLocaleString("ko-KR")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 10 && <p className="sc-more">그 밖의 챔피언 {rows.length - 10}개 · {rows.slice(10).reduce((n, c) => n + c.games, 0)}판</p>}
    </div>
  );
}
