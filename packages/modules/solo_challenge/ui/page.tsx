/**
 * 솔랭 도전 화면. host 가 등록부의 경로(/lol/challenges, /lol/challenges/[slug])를 보고 여기를 띄운다.
 * 틀(nav·본문 폭)은 host 가 씌운다 — 여기는 내용만 그린다. 거르기는 주소(?f=)로 한다(클라이언트 상태 없음).
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";

import { championById, championIconPath, profileHref } from "@soop-lol/core/lib/contract";

import { getChallenge, listChallenges, progressAt, type ChallengeView, type GameRow, type MemberLine } from "../server/index.ts";
import { challengeHref, challengesHref } from "./paths.ts";
import "./challenge.css";

type Props = { params?: Record<string, string>; searchParams: Record<string, string | string[] | undefined> };

const load = cache(getChallenge);

export async function generateMetadata({ params }: Props) {
  if (!params?.slug) return { title: "솔랭 도전" };
  return { title: (await load(params.slug))?.def.title ?? "솔랭 도전" };
}

const TIER_KO: Record<string, string> = {
  IRON: "아이언", BRONZE: "브론즈", SILVER: "실버", GOLD: "골드", PLATINUM: "플래티넘", EMERALD: "에메랄드",
  DIAMOND: "다이아몬드", MASTER: "마스터", GRANDMASTER: "그랜드마스터", CHALLENGER: "챌린저",
};
const rankText = (m: MemberLine) => (m.rank?.tier ? `${TIER_KO[m.rank.tier] ?? m.rank.tier}${m.rank.division && !["MASTER", "GRANDMASTER", "CHALLENGER"].includes(m.rank.tier) ? ` ${m.rank.division}` : ""} ${m.rank.lp ?? 0}LP` : "랭크 기록 없음");
const pctText = (v: number) => `${Math.round(v * 100)}%`;
const fmt = (v: number, d = 0) => (Number.isInteger(v) ? String(v) : v.toFixed(d));

export default async function SoloChallengePage({ params, searchParams }: Props) {
  if (!params?.slug) {
    const all = await listChallenges();
    return (
      <div className="sc-page">
        <header className="sc-head"><span className="sc-eyebrow">솔로랭크</span><h1>솔랭 도전</h1>
          <p className="sc-muted">스트리머들이 목표 티어를 정하고 솔로랭크를 올리는 도전을 모았습니다.</p></header>
        <div className="sc-list">
          {all.map((v) => (
            <Link key={v.def.slug} href={challengeHref(v.def.slug)} className="sc-card">
              <b>{v.def.title}</b>
              <span className="sc-muted">{v.def.summary}</span>
              <Ladder view={v} compact />
            </Link>
          ))}
        </div>
      </div>
    );
  }
  const v = await load(params.slug);
  if (!v) notFound();
  const f = typeof searchParams.f === "string" ? searchParams.f : "all";
  return (
    <div className="sc-page" style={Object.fromEntries(v.def.members.map((m, i) => [`--sc-m${i}`, `var(--sc-${m.color})`])) as React.CSSProperties}>
      <header className="sc-head">
        <Link href={challengesHref()} className="sc-back">← 솔랭 도전</Link>
        <h1>{v.def.title}</h1>
        <p className="sc-muted">{v.def.summary}</p>
      </header>

      <section aria-labelledby="sc-now">
        <h2 id="sc-now">지금 어디까지 왔나</h2>
        <div className="sc-panel"><Ladder view={v} /></div>
        <p className="sc-note">랭크는 하루 한 번 찍는 스냅샷 기준입니다({v.members.map((m) => m.rank?.date).filter(Boolean)[0] ?? "기록 없음"}). 1구간 100LP로 계산했습니다.</p>
      </section>

      <section aria-labelledby="sc-days">
        <h2 id="sc-days">방송한 날</h2>
        <div className="sc-days">
          {[...v.days].reverse().map((d) => (
            <div key={d.day} className="sc-day">
              <span className="sc-muted sc-small">{d.day.slice(5).replace("-", ".")}</span>
              <b className="sc-num">{d.wins}승 {d.losses}패</b>
              <span className="sc-pips">{d.results.map((w, i) => <i key={i} className={w ? "w" : "l"} />)}</span>
            </div>
          ))}
        </div>
        <p className="sc-note">파란 칸은 승, 빨간 칸은 패, 왼쪽부터 시간 순 · 최장 연승 {v.record.bestWinStreak} · 최장 연패 {v.record.worstLoseStreak}</p>
      </section>

      {v.def.members.length === 2 && (
        <section aria-labelledby="sc-chem">
          <h2 id="sc-chem">둘의 케미 · 누가 더 했나</h2>
          <div className="sc-panel sc-chem">
            <div className="sc-chem-head">
              <Who v={v} i={0} />
              <span className="sc-muted sc-num">같이 {v.record.together}판 {v.record.togetherWins}승 {v.record.together - v.record.togetherWins}패</span>
              <Who v={v} i={1} right />
            </div>
            <div className="sc-vs">
              {([
                ["팀 딜 비중(평균)", v.stats.map((s) => s.damageShare), "%"],
                ["킬 관여율(평균)", v.stats.map((s) => s.kp), "%"],
                ["KDA", v.stats.map((s) => s.kda), ""],
                ["분당 딜", v.stats.map((s) => s.dpm), ""],
                ["솔로킬(합계)", v.stats.map((s) => s.soloKills), ""],
                ["둘 중 딜 더 넣은 판", v.stats.map((s) => s.moreDamage), "판"],
              ] as [string, number[], string][]).map(([label, [a, b], u]) => {
                const max = Math.max(a, b) || 1;
                const show = (x: number) => `${label === "KDA" ? x.toFixed(2) : fmt(Math.round(x))}${u}`;
                return [
                  <span key={`${label}a`} className="sc-num sc-r">{show(a)}</span>,
                  <span key={`${label}l`} className="sc-label">{label}</span>,
                  <span key={`${label}b`} className="sc-num">{show(b)}</span>,
                  <span key={`${label}ba`} className="sc-bar sc-left"><i style={{ width: `${(a / max) * 100}%` }} /></span>,
                  <span key={`${label}s`} />,
                  <span key={`${label}bb`} className="sc-bar sc-right"><i style={{ width: `${(b / max) * 100}%` }} /></span>,
                ];
              })}
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="sc-champ">
        <h2 id="sc-champ">챔피언</h2>
        <div className="sc-grid">
          {v.stats.map((s, i) => (
            <div key={i} className="sc-panel sc-champs">
              <Who v={v} i={i} />
              {s.champs.slice(0, 6).map((c) => (
                <div key={c.id} className="sc-crow">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 정적 챔피언 아이콘 */}
                  {championById(c.id) ? <img src={championIconPath(championById(c.id)!)} alt="" width={24} height={24} /> : <span />}
                  <span>{c.name}</span>
                  <span className="sc-wl" title={`${c.wins}승 ${c.losses}패`}><i className="w" style={{ width: `${(c.wins / (c.wins + c.losses)) * 100}%` }} /><i className="l" style={{ width: `${(c.losses / (c.wins + c.losses)) * 100}%` }} /></span>
                  <span className="sc-num sc-muted sc-r">{c.wins}-{c.losses} ({pctText(c.shrunk)})</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="sc-note">괄호 안 승률은 판 수가 적으면 50%쪽으로 당긴 값입니다. 3승 0패를 "승률 100%"로 쓰지 않으려는 것입니다.</p>
      </section>

      {v.coPlayers.length > 0 && (
        <section aria-labelledby="sc-met">
          <h2 id="sc-met">솔랭에서 만난 스트리머</h2>
          <div className="sc-panel sc-met">
            {v.coPlayers.slice(0, 12).map((c) => (
              <Link key={c.slug} href={profileHref("lol", c.slug)} className="sc-chip">
                {c.name} <span className="sc-muted">같은 팀 {c.ally} · 상대 {c.enemy}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="sc-games">
        <h2 id="sc-games">판별 기록</h2>
        <nav className="sc-filters" aria-label="거르기">
          {[["all", "전체"], ["w", "이긴 판"], ["l", "진 판"], ["solo", "솔킬 3+ 판"]].map(([k, label]) => (
            <Link key={k} href={challengeHref(v.def.slug, k === "all" ? undefined : { f: k })} aria-current={f === k ? "true" : undefined} scroll={false}>{label}</Link>
          ))}
        </nav>
        <div className="sc-tablewrap">
          <table className="sc-table">
            <thead><tr><th>시각(KST)</th><th>결과</th><th>시간</th>{v.def.members.map((m) => <th key={m.puuid}>{m.name}</th>)}<th>그 판의 이야기</th></tr></thead>
            <tbody>
              {[...v.games].reverse().filter((g) => keep(g, f)).map((g) => (
                <tr key={g.matchId}>
                  <td className="sc-num">{kstShort(g.at)}</td>
                  <td className={`sc-res ${g.win ? "w" : "l"}`}>{g.win ? "승" : "패"}</td>
                  <td className="sc-num">{g.minutes}분</td>
                  {g.lines.map((l, i) => (
                    <td key={i}>{l ? <>{l.champName} <span className="sc-num">{l.kills}/{l.deaths}/{l.assists}</span> <span className="sc-faint">관여 {l.kp}%</span></> : <span className="sc-faint">—</span>}</td>
                  ))}
                  <td>{g.tags.length ? g.tags.map((t) => <span key={t} className={`sc-tag${/솔킬/.test(t) ? " hot" : ""}`}>{t}</span>) : <span className="sc-faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {v.riotGames != null && v.riotGames > v.record.games && (
          <p className="sc-note">Riot 기준 시즌 {v.riotGames}판 중 {v.record.games}판이 수집됐습니다. 나머지는 수집되는 대로 늘어납니다.</p>
        )}
      </section>
    </div>
  );
}

function keep(g: GameRow, f: string): boolean {
  if (f === "w") return g.win;
  if (f === "l") return !g.win;
  if (f === "solo") return g.lines.some((l) => (l?.soloKills ?? 0) >= 3);
  return true;
}

/** KST 짧은 시각 — toLocaleString 은 서버·브라우저 로케일이 달라 쓰지 않는다. */
function kstShort(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}.${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function Who({ v, i, right = false }: { v: ChallengeView; i: number; right?: boolean }) {
  const m = v.def.members[i];
  return (
    <Link href={profileHref("lol", m.streamer)} className={`sc-who${right ? " sc-r" : ""}`}>
      {!right && <span className="sc-dot" style={{ background: `var(--sc-m${i})` }} />}
      {m.name} <span className="sc-faint">· {m.role}</span>
      {right && <span className="sc-dot" style={{ background: `var(--sc-m${i})` }} />}
    </Link>
  );
}

/** 진행도 — 막대 하나에 멤버 모두의 위치. 왼쪽 끝은 가장 낮은 멤버가 든 티어의 시작, 오른쪽 끝은 목표. */
function Ladder({ view, compact = false }: { view: ChallengeView; compact?: boolean }) {
  const span = view.goalAbs - view.floorAbs;
  const ticks = Array.from({ length: span / 100 + 1 }, (_, k) => view.floorAbs + k * 100);
  const major = ticks.filter((t) => t % 400 === 0);
  const label = (abs: number) => {
    if (abs >= view.goalAbs) return TIER_KO[view.def.goal.tier] ?? view.def.goal.tier;
    const tiers = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
    return `${TIER_KO[tiers[Math.floor(abs / 400)]] ?? ""} IV`;
  };
  const placed = view.members.map((m, i) => ({ m, i, at: m.rank?.abs != null ? progressAt(m.rank.abs, view.floorAbs, view.goalAbs) : null }));
  return (
    <div className="sc-ladder" style={Object.fromEntries(view.def.members.map((m, i) => [`--sc-m${i}`, `var(--sc-${m.color})`])) as React.CSSProperties}>
      {!compact && (
        <div className="sc-tags" aria-hidden="true">
          {placed.map(({ m, i, at }) => at != null && <span key={i} style={{ left: `${at}%`, color: `var(--sc-m${i})` }}>{m.member.name} ▾</span>)}
        </div>
      )}
      <div className="sc-track" role="img" aria-label={view.members.map((m) => `${m.member.name} ${rankText(m)}, 목표까지 ${m.rank?.toGoal ?? "?"}LP`).join(" · ")}>
        {ticks.slice(1, -1).map((t) => <span key={t} className={`sc-seg${t % 400 === 0 ? " major" : ""}`} style={{ left: `${progressAt(t, view.floorAbs, view.goalAbs)}%` }} />)}
        {placed.map(({ i, at }) => at != null && <span key={i} className="sc-me" style={{ left: `calc(${at}% - 2px)`, background: `var(--sc-m${i})` }} />)}
      </div>
      <div className="sc-ticks">
        {[...major.filter((t) => t < view.goalAbs), view.goalAbs].map((t) => <span key={t} style={{ left: `${progressAt(t, view.floorAbs, view.goalAbs)}%` }}>{label(t)}</span>)}
      </div>
      <div className="sc-legend">
        {view.members.map((m, i) => (
          <div key={i}>
            <span className="sc-who"><span className="sc-dot" style={{ background: `var(--sc-m${i})` }} />{m.member.name}</span>
            <div className="sc-bigline"><b className="sc-big">{rankText(m)}</b>{m.rank && <span className="sc-muted">{m.rank.toGoal ? <>목표까지 <b className="sc-num">{m.rank.toGoal}</b>LP</> : "목표 달성"}</span>}</div>
            {!compact && m.rank?.wins != null && <span className="sc-muted sc-small sc-num">시즌 {m.rank.wins}승 {m.rank.losses}패</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
