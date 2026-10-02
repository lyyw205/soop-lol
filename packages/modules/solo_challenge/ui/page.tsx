/**
 * 솔랭 도전 화면. host 가 등록부의 경로(/lol/challenges, /lol/challenges/[slug])를 보고 여기를 띄운다.
 * 틀(nav·본문 폭)은 host 가 씌운다 — 여기는 내용만 그린다. 거르기는 주소(?f=)로 한다(클라이언트 상태 없음).
 * 챔피언 표·판 목록은 전적 사이트(OP.GG)와 같은 배치를 따른다 — 보는 사람이 이미 익숙한 모양이다.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";

import {
  championById, championIconPath, itemIconPath, itemName, profileHref, runeIconPath, runeName, spellIconPath, spellName,
} from "@soop-lol/core/lib/contract";

import {
  getChallenge, listChallenges, progressAt,
  type ChallengeView, type ChampRow, type GameRow, type Line, type MemberLine,
} from "../server/index.ts";
import { challengeHref, challengesHref } from "./paths.ts";
import "./challenge.css";

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
/** 막대 끝에 가까운 이름표는 안쪽으로 붙인다(잘리지 않게). */
const tagPos = (left: number): React.CSSProperties => ({ left: `${left}%`, transform: left < 8 ? "none" : left > 92 ? "translateX(-100%)" : "translateX(-50%)" });
const colorVars = (v: ChallengeView) => Object.fromEntries(v.def.members.map((m, i) => [`--sc-m${i}`, `var(--sc-${m.color})`])) as React.CSSProperties;

/** KST 짧은 시각 — toLocaleString 은 서버·브라우저 로케일이 달라 쓰지 않는다. */
function kstShort(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}.${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
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
  const f = typeof searchParams.f === "string" ? searchParams.f : "all";
  return (
    <div className="sc-page" style={colorVars(v)}>
      <header className="sc-head">
        <Link href={challengesHref()} className="sc-back">← 솔랭 도전</Link>
        <h1>{v.def.title}</h1>
        <p className="sc-muted">{v.def.summary}</p>
      </header>

      <section aria-labelledby="sc-now">
        <h2 id="sc-now">지금 어디까지 왔나</h2>
        <div className="sc-panel"><Progress view={v} /></div>
        <p className="sc-note">지금 랭크는 하루 한 번 찍는 스냅샷({v.members.map((m) => m.rank?.date).filter(Boolean)[0] ?? "기록 없음"}) 기준, 출발점은 방송 화면에서 확인한 값입니다. Riot 은 과거 랭크를 주지 않습니다.</p>
      </section>

      <section aria-labelledby="sc-flow">
        <h2 id="sc-flow">승패 흐름</h2>
        <div className="sc-panel"><Flow view={v} /></div>
      </section>

      <section aria-labelledby="sc-days">
        <h2 id="sc-days">방송 일지</h2>
        <div className="sc-tablewrap">
          <table className="sc-table">
            <thead><tr><th>날짜</th><th>판</th><th>승패</th><th>승률</th>{v.def.members.map((m) => <th key={m.puuid}>{m.name} 주력</th>)}<th>그날 최고의 판</th></tr></thead>
            <tbody>
              {[...v.days].reverse().map((d) => (
                <tr key={d.day}>
                  <td className="sc-num">{dayText(d.day)}</td>
                  <td className="sc-num">{d.games}</td>
                  <td className="sc-num"><span className="sc-w">{d.wins}승</span> <span className="sc-l">{d.losses}패</span></td>
                  <td className="sc-num">{Math.round((d.wins / d.games) * 100)}%</td>
                  {d.topChamps.map((c, i) => <td key={i}>{c ?? <span className="sc-faint">—</span>}</td>)}
                  <td>{d.best ? <a href={`#g-${d.best.matchId}`}>{d.best.who} · {d.best.text}</a> : <span className="sc-faint">이긴 판 없음</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {v.chemistry && <Chemistry view={v} />}

      <section aria-labelledby="sc-rec">
        <h2 id="sc-rec">기록실</h2>
        <div className="sc-records">
          {v.records.map((r) => (
            <div key={r.key} className="sc-record">
              <span className="sc-label">{r.label}</span>
              <b className="sc-num">{r.value}</b>
              <span className="sc-muted sc-small">
                {[r.who, r.champ, r.at ? kstShort(r.at) : null, r.note].filter(Boolean).join(" · ")}
                {r.matchId && <> · <a href={`#g-${r.matchId}`}>판 보기</a></>}
              </span>
            </div>
          ))}
        </div>
        <p className="sc-note">이 도전의 판만 셉니다. 다시하기(5분 미만)는 빼고 셉니다.</p>
      </section>

      <section aria-labelledby="sc-champ">
        <h2 id="sc-champ">챔피언</h2>
        <div className="sc-grid">
          {v.stats.map((s, i) => <ChampTable key={i} view={v} i={i} rows={s.champs} />)}
        </div>
        <p className="sc-note">승률은 판 수가 적으면 50%쪽으로 당긴 값입니다(4판을 반반으로 더함). 3승 0패를 "승률 100%"로 쓰지 않습니다.</p>
      </section>

      {v.coPlayers.length > 0 && (
        <section aria-labelledby="sc-met">
          <h2 id="sc-met">솔랭에서 만난 스트리머</h2>
          <div className="sc-panel sc-met">
            {v.coPlayers.slice(0, 16).map((c) => (
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
        <ol className="sc-games">
          {[...v.games].reverse().filter((g) => keep(g, f)).map((g) => <GameCard key={g.matchId} view={v} g={g} />)}
        </ol>
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

/* ── 진행도: 막대 하나에 모두 — 사람마다 출발점(○)과 지금(●) 두 점만. 사이를 채우지 않아야 여럿이 한 줄에 들어간다 ── */
function Progress({ view, compact = false }: { view: ChallengeView; compact?: boolean }) {
  const at = (abs: number) => progressAt(abs, view.floorAbs, view.goalAbs);
  const majors: number[] = [];
  for (let t = Math.ceil(view.floorAbs / 400) * 400; t < view.goalAbs; t += 400) majors.push(t);
  return (
    <div className="sc-progress">
      {!compact && (
        <div className="sc-ptags" aria-hidden="true">
          {view.members.map((m, i) => m.rank?.abs != null && (
            <span key={i} style={{ ...tagPos(at(m.rank.abs)), color: `var(--sc-m${i})` }}>{m.member.name} ▾</span>
          ))}
        </div>
      )}
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
      {!compact && (
        <div className="sc-ptags under" aria-hidden="true">
          {view.members.map((m, i) => m.startAbs != null && (
            <span key={i} style={{ ...tagPos(at(m.startAbs)), color: `var(--sc-m${i})` }}>▴ {m.member.name} 출발</span>
          ))}
        </div>
      )}
      <div className="sc-pticks" aria-hidden="true">
        {majors.map((t) => <span key={t} style={{ left: `${at(t)}%` }}>{tierAt(t)}</span>)}
        <span className="goal" style={{ left: "100%" }}>{TIER_KO[view.def.goal.tier] ?? view.def.goal.tier}</span>
      </div>
      <div className="sc-plegend">
        {view.members.map((m, i) => (
          <div key={i} className="sc-ptext">
            <span className="sc-who"><span className="sc-dot" style={{ background: `var(--sc-m${i})` }} />{m.member.name}{!compact && <span className="sc-faint sc-small">· {m.member.role}</span>}</span>
            <b className="sc-num">{rankText(m.rank?.tier, m.rank?.division, m.rank?.lp)}</b>
            <span className="sc-muted sc-small">
              {m.gained != null ? <><b className="sc-num" style={{ color: `var(--sc-m${i})` }}>{m.gained >= 0 ? "+" : ""}{m.gained}LP</b> 왔음 · </> : <>출발 기록 없음 · </>}
              {m.toGoal ? <><b className="sc-num">{m.toGoal}</b>LP 남음</> : "목표 달성"}
            </span>
            {!compact && m.member.start && (
              <span className="sc-faint sc-small">출발 {rankText(m.member.start.tier, m.member.start.division, m.member.start.lp)} · {m.member.start.date}
                {m.member.start.source && <> · <a href={m.member.start.source} target="_blank" rel="noreferrer">방송 화면 ↗</a></>}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 승패 흐름: 누적(승−패) 선, 날짜마다 구분선 ── */
function Flow({ view }: { view: ChallengeView }) {
  const pts = view.flow;
  if (!pts.length) return <p className="sc-muted">아직 판이 없습니다.</p>;
  const W = 900, H = 220, P = { l: 34, r: 12, t: 14, b: 26 };
  const max = Math.max(1, ...pts.map((p) => p.net)), min = Math.min(-1, ...pts.map((p) => p.net));
  const step = (W - P.l - P.r) / pts.length;
  const x = (i: number) => P.l + step * (i + 0.5);
  const y = (n: number) => P.t + ((H - P.t - P.b) * (max - n)) / (max - min);
  const path = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.net).toFixed(1)}`).join(" ");
  const dayStarts = pts.filter((p, k) => k === 0 || pts[k - 1].day !== p.day);
  const ticks = Array.from(new Set([max, 0, min]));
  const last = pts.at(-1)!;
  return (
    <div className="sc-flow">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`누적 승패 그래프: 최고 ${max}, 최저 ${min}, 지금 ${last.net}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className={t === 0 ? "zero" : "grid"} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="tick">{t > 0 ? `+${t}` : t}</text>
          </g>
        ))}
        {dayStarts.map((p) => (
          <g key={p.day}>
            <line x1={x(p.i) - step / 2} x2={x(p.i) - step / 2} y1={P.t} y2={H - P.b} className="day" />
            <text x={x(p.i) - step / 2 + 3} y={H - 8} className="tick">{dayText(p.day)}</text>
          </g>
        ))}
        <path d={path} className="line" />
        {pts.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.net)} r={2.6} className={p.win ? "w" : "l"} />)}
        <circle cx={x(last.i)} cy={y(last.net)} r={5} className="end" />
      </svg>
      <p className="sc-note">이기면 한 칸 오르고 지면 한 칸 내려갑니다 · 지금 {last.net >= 0 ? "+" : ""}{last.net} · 최장 연승 {view.record.bestWinStreak} · 최장 연패 {view.record.worstLoseStreak}</p>
    </div>
  );
}

/* ── 케미: 같이 만든 결과 ── */
function Chemistry({ view }: { view: ChallengeView }) {
  const c = view.chemistry!;
  const [a, b] = view.def.members;
  const tile = (label: string, x: { games: number; wins: number }, hint: string) => (
    <div className="sc-tile">
      <span className="sc-label">{label}</span>
      <b className="sc-num">{x.games}판 <span className="sc-w">{x.wins}승</span> <span className="sc-l">{x.games - x.wins}패</span></b>
      <span className="sc-faint sc-small">{hint}</span>
    </div>
  );
  return (
    <section aria-labelledby="sc-chem">
      <h2 id="sc-chem">둘의 케미</h2>
      <div className="sc-tiles">
        {tile("둘 다 잘한 판", c.bothGood, "둘 다 KDA 3 이상")}
        {tile("한 명이 캐리한 판", c.oneCarry, "한 명만 KDA 3 이상")}
        {tile("둘 다 부진한 판", c.bothBad, "둘 다 KDA 1.5 미만")}
      </div>
      <div className="sc-grid">
        <div className="sc-panel sc-chemlist">
          <p className="sc-label">서로 돕기 (같이 한 {c.together}판)</p>
          <div className="sc-chemrow"><span>초반 다른 라인 킬 관여</span><b className="sc-num">{a.name} {c.roam[0]} · {b.name} {c.roam[1]}</b></div>
          <div className="sc-chemrow"><span>아군을 죽음에서 살림</span><b className="sc-num">{a.name} {c.saves[0]} · {b.name} {c.saves[1]}</b></div>
          <div className="sc-chemrow"><span>아군과 함께 잡은 킬(판당)</span><b className="sc-num">{a.name} {c.pickWithAlly[0].toFixed(1)} · {b.name} {c.pickWithAlly[1].toFixed(1)}</b></div>
          <p className="sc-faint sc-small">Riot 이 판마다 주는 값입니다. "아군"은 듀오 파트너만이 아니라 팀원 누구든입니다.</p>
        </div>
        <div className="sc-panel sc-chemlist">
          <p className="sc-label">조합 ({a.role} + {b.role})</p>
          {c.combos.slice(0, 6).map((x) => (
            <div key={x.champs.join("+")} className="sc-chemrow">
              <span>{x.champs.join(" + ")}</span>
              <b className="sc-num">{x.wins}승 {x.games - x.wins}패 <span className="sc-faint">({pct(x.shrunk)})</span></b>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── 챔피언 표(전적 사이트 형식) ── */
function ChampTable({ view, i, rows }: { view: ChallengeView; i: number; rows: ChampRow[] }) {
  const m = view.def.members[i];
  return (
    <div className="sc-tablewrap">
      <table className="sc-table sc-champtable">
        <caption><span className="sc-dot" style={{ background: `var(--sc-m${i})` }} />{m.name} · {m.role}</caption>
        <thead><tr><th>챔피언</th><th>판</th><th>승률</th><th>KDA</th><th>CS</th><th>딜/분</th></tr></thead>
        <tbody>
          {rows.slice(0, 10).map((c) => {
            const champ = championById(c.id);
            return (
              <tr key={c.id}>
                <td><span className="sc-champcell">{champ && <img src={championIconPath(champ)} alt="" width={28} height={28} />}{c.name}</span></td>
                <td className="sc-num">{c.games}</td>
                <td className="sc-num"><b className={c.shrunk >= 0.5 ? "sc-w" : "sc-l"}>{pct(c.shrunk)}</b> <span className="sc-faint">{c.wins}승 {c.losses}패</span></td>
                <td className="sc-num"><b>{c.kda.toFixed(2)}</b> <span className="sc-faint">{(c.kills / c.games).toFixed(1)}/{(c.deaths / c.games).toFixed(1)}/{(c.assists / c.games).toFixed(1)}</span></td>
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

/* ── 판 카드(전적 사이트 형식) ── */
function Icon({ src, label, size = 22, round = false }: { src: string | null; label: string | null; size?: number; round?: boolean }) {
  return src
    ? <img src={src} alt={label ?? ""} title={label ?? undefined} width={size} height={size} className={round ? "round" : undefined} />
    : <span className="sc-iconblank" style={{ width: size, height: size }} />;
}

function PlayerLine({ name, i, l, minutes }: { name: string; i: number; l: Line; minutes: number }) {
  const champ = championById(l.champId);
  const six = l.items.slice(0, 6);
  const items = [...six, ...Array<number>(Math.max(0, 6 - six.length)).fill(0)];
  return (
    <div className="sc-pline">
      <span className="sc-pname" style={{ color: `var(--sc-m${i})` }}>{name}</span>
      <span className="sc-build">
        <span className="sc-champ">{champ && <img src={championIconPath(champ)} alt={l.champName} title={l.champName} width={44} height={44} />}</span>
        <span className="sc-stack">
          <Icon src={spellIconPath(l.spells[0])} label={spellName(l.spells[0])} />
          <Icon src={spellIconPath(l.spells[1])} label={spellName(l.spells[1])} />
        </span>
        <span className="sc-stack">
          <Icon src={runeIconPath(l.keystone)} label={runeName(l.keystone)} round />
          <Icon src={runeIconPath(l.subStyle)} label={runeName(l.subStyle)} round />
        </span>
      </span>
      <span className="sc-kda">
        <b className="sc-num">{l.kills} / <span className="sc-l">{l.deaths}</span> / {l.assists}</b>
        <span className="sc-muted sc-small sc-num">{((l.kills + l.assists) / Math.max(1, l.deaths)).toFixed(2)} KDA</span>
      </span>
      <span className="sc-sub sc-small sc-num">
        <span>킬관여 {l.kp}%</span>
        <span>CS {l.cs} ({(l.cs / Math.max(1, minutes)).toFixed(1)})</span>
        <span>딜 {l.damage.toLocaleString("ko-KR")}</span>
      </span>
      <span className="sc-items">
        {items.map((id, k) => <Icon key={k} src={id ? itemIconPath(id) : null} label={id ? itemName(id) : null} />)}
        <Icon src={l.items[6] ? itemIconPath(l.items[6]) : null} label={l.items[6] ? itemName(l.items[6]) : null} round />
      </span>
    </div>
  );
}

function GameCard({ view, g }: { view: ChallengeView; g: GameRow }) {
  const teams = [g.teamId, g.teamId === 100 ? 200 : 100].map((t) => g.lineup.filter((s) => s.teamId === t));
  return (
    <li id={`g-${g.matchId}`} className={`sc-game ${g.win ? "win" : "loss"}`}>
      <div className="sc-gmeta">
        <b className={g.win ? "sc-w" : "sc-l"}>{g.win ? "승리" : "패배"}</b>
        <span className="sc-muted sc-small">솔로랭크</span>
        <span className="sc-muted sc-small sc-num">{kstShort(g.at)}</span>
        <span className="sc-muted sc-small sc-num">{Math.floor(g.seconds / 60)}분 {g.seconds % 60}초{g.surrender ? " · 서렌" : ""}</span>
      </div>
      <div className="sc-glines">
        {g.lines.map((l, i) => l && <PlayerLine key={i} name={view.def.members[i].name} i={i} l={l} minutes={g.minutes} />)}
        {g.tags.length > 0 && <div className="sc-tags">{g.tags.map((t) => <span key={t} className={`sc-tag${/솔킬/.test(t) ? " hot" : ""}`}>{t}</span>)}</div>}
      </div>
      {g.lineup.length > 0 && (
        <div className="sc-lineup" aria-label="양 팀">
          {teams.map((team, k) => (
            <ul key={k}>
              {team.map((s, j) => {
                const champ = championById(s.champId);
                return (
                  <li key={j} className={s.member != null ? "me" : undefined}>
                    {champ && <img src={championIconPath(champ)} alt="" width={16} height={16} />}
                    {s.slug ? <Link href={profileHref("lol", s.slug)}>{s.name}</Link> : <span className="sc-faint">{champ?.name ?? "?"}</span>}
                  </li>
                );
              })}
            </ul>
          ))}
        </div>
      )}
    </li>
  );
}
