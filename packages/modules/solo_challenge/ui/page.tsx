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
  type ChallengeView, type ChampRow, type GameRow, type Line, type MemberLine, type Run,
} from "../server/index.ts";
import { challengeHref, challengesHref } from "./paths.ts";
import { ShowMore } from "./show-more.tsx";
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
        <div className="sc-panel"><Streaks view={v} /></div>
      </section>

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
        <ShowMore key={f} step={10}>
          {[...v.games].reverse().filter((g) => keep(g, f)).map((g) => <GameCard key={g.matchId} view={v} g={g} />)}
        </ShowMore>
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

/* ── 승패 흐름: 누적(승−패) 선. 날짜마다 띠(번갈아 칠함)와 굵은 경계선, 띠 위쪽에 날짜·그날 승패 ──
 *   날짜마다 폭은 판 수에 비례하되 최소 폭을 줘서, 두 판뿐인 날도 글자가 겹치지 않게 한다. */
function Streaks({ view }: { view: ChallengeView }) {
  const r = view.record;
  const runText = (x: Run) => (x.n === 1 ? (x.win ? "1승" : "1패") : `${x.n}${x.win ? "연승" : "연패"}`);
  if (!view.flow.length) return <p className="sc-muted">아직 판이 없습니다.</p>;
  const W = 1000, H = 300, HEAD = 46, P = { l: 36, r: 10, b: 26 };
  const MIN_UNITS = 4;
  const units = view.days.map((d) => Math.max(d.games, MIN_UNITS));
  const total = units.reduce((a, b) => a + b, 0);
  const plotW = W - P.l - P.r;
  // 날짜 띠의 시작 x 와 폭
  let acc = 0;
  const bands = view.days.map((d, k) => { const x0 = P.l + (acc / total) * plotW; acc += units[k]; return { d, x0, w: (units[k] / total) * plotW }; });
  // 판마다 x — 그 날 띠 안에 고르게
  const xs: number[] = [];
  bands.forEach(({ d, x0, w }) => { for (let j = 0; j < d.games; j++) xs.push(x0 + (w * (j + 0.5)) / d.games); });
  const nets = view.flow.map((p) => p.net);
  const max = Math.max(1, ...nets), min = Math.min(-1, ...nets);
  const top = HEAD + 22, bottom = H - P.b;
  const y = (n: number) => top + ((bottom - top) * (max - n)) / (max - min);
  const pts = [{ x: P.l, y: y(0) }, ...view.flow.map((p, i) => ({ x: xs[i], y: y(p.net) }))];
  const path = pts.map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${path} L${pts.at(-1)!.x.toFixed(1)},${y(0).toFixed(1)} Z`;
  const last = pts.at(-1)!;
  const ticks = Array.from(new Set([max, 0, min]));
  // 꺾이는 지점 — 연속 결과가 끝나는 판. 한 판짜리는 적지 않는다(봉우리마다 "1연승"이 붙으면 읽히지 않는다).
  const turns: { i: number; n: number; win: boolean; net: number }[] = [];
  view.flow.forEach((p, i) => {
    const next = view.flow[i + 1];
    if (next && next.win === p.win) return;
    let n = 1;
    while (i - n >= 0 && view.flow[i - n].win === p.win) n++;
    if (n >= 2) turns.push({ i, n, win: p.win, net: p.net });
  });
  return (
    <div className="sc-streaks">
      <div className="sc-ssum">
        <span><span className="sc-label">전체</span><b className="sc-num"><span className="sc-w">{r.wins}승</span> <span className="sc-l">{r.games - r.wins}패</span></b></span>
        {r.current && <span><span className="sc-label">지금</span><b className={`sc-num ${r.current.win ? "sc-w" : "sc-l"}`}>{runText(r.current)}</b></span>}
        <span><span className="sc-label">최장 연승</span><b className="sc-num sc-w">{r.bestWinStreak}연승</b></span>
        <span><span className="sc-label">최장 연패</span><b className="sc-num sc-l">{r.worstLoseStreak}연패</b></span>
      </div>
      <div className="sc-flow">
        <svg viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={`누적 승패: ${view.days.map((d) => `${dayText(d.day)} ${d.wins}승 ${d.losses}패`).join(", ")}. 지금 ${last && nets.at(-1)! >= 0 ? "+" : ""}${nets.at(-1)}`}>
          <defs>
            <clipPath id="sc-up"><rect x={P.l} y={0} width={plotW} height={y(0)} /></clipPath>
            <clipPath id="sc-down"><rect x={P.l} y={y(0)} width={plotW} height={H} /></clipPath>
          </defs>
          {bands.map(({ d, x0, w }, k) => (
            <g key={d.day}>
              <rect x={x0} y={0} width={w} height={H} className={k % 2 ? "band odd" : "band"} />
              {k > 0 && <line x1={x0} x2={x0} y1={0} y2={H} className="sep" />}
              <text x={x0 + w / 2} y={18} textAnchor="middle" className="dlabel">{dayText(d.day)}</text>
              <text x={x0 + w / 2} y={36} textAnchor="middle" className="drec">
                <tspan className="w">{d.wins}승</tspan><tspan dx="4" className="l">{d.losses}패</tspan>
              </text>
            </g>
          ))}
          <line x1={P.l} x2={W - P.r} y1={HEAD} y2={HEAD} className="headline" />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className={t === 0 ? "zero" : "grid"} />
              <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="tick">{t > 0 ? `+${t}` : t}</text>
            </g>
          ))}
          <path d={area} className="fill up" clipPath="url(#sc-up)" />
          <path d={area} className="fill down" clipPath="url(#sc-down)" />
          <path d={path} className="line" />
          {turns.map((t) => (
            <text key={t.i} x={xs[t.i]} y={t.win ? y(t.net) - 8 : y(t.net) + 16} textAnchor="middle" className={`turn ${t.win ? "w" : "l"}`}>
              {t.n}{t.win ? "연승" : "연패"}
            </text>
          ))}
          <circle cx={last.x} cy={last.y} r={5} className="end" />
        </svg>
      </div>
      <p className="sc-note">이기면 한 칸 오르고 지면 한 칸 내려갑니다(0 = 승패 같음). 띠 하나가 하루이고, 위에 그날 승패를 적었습니다.</p>
    </div>
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
      <details>
        <summary>
          <span className="sc-gmeta">
            <b className={g.win ? "sc-w" : "sc-l"}>{g.win ? "승리" : "패배"}</b>
            <span className="sc-muted sc-small sc-num">{kstShort(g.at)}</span>
            <span className="sc-muted sc-small sc-num">{Math.floor(g.seconds / 60)}:{String(g.seconds % 60).padStart(2, "0")}{g.surrender ? " · 서렌" : ""}</span>
          </span>
          <span className="sc-gsum">
            {g.lines.map((l, i) => l && <SummaryLine key={i} i={i} name={view.def.members[i].name} l={l} />)}
          </span>
          {g.tags.length > 0 && <span className="sc-tags sc-gtags">{g.tags.slice(0, 3).map((t) => <span key={t} className={`sc-tag${/솔킬/.test(t) ? " hot" : ""}`}>{t}</span>)}</span>}
          <span className="sc-caret" aria-hidden="true">▾</span>
        </summary>
        <div className="sc-gdetail">
          <div className="sc-glines">
            {g.lines.map((l, i) => l && <PlayerLine key={i} name={view.def.members[i].name} i={i} l={l} minutes={g.minutes} />)}
          </div>
          {g.lineup.length > 0 && (
            <div className="sc-lineup" aria-label="양 팀">
              {teams.map((team, k) => (
                <div key={k}>
                  <p className="sc-label">{k === 0 ? `우리 팀 · ${g.win ? "승리" : "패배"}` : `상대 팀 · ${g.win ? "패배" : "승리"}`}</p>
                  <ul>
                    {team.map((s, j) => {
                      const champ = championById(s.champId);
                      return (
                        <li key={j} className={s.member != null ? "me" : undefined}>
                          {champ && <img src={championIconPath(champ)} alt="" width={20} height={20} />}
                          <span className="sc-lname">{s.slug ? <Link href={profileHref("lol", s.slug)}>{s.name}</Link> : <span className="sc-faint">{champ?.name ?? "?"}</span>}</span>
                          <span className="sc-num sc-muted">{s.kills}/{s.deaths}/{s.assists}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {g.tags.length > 3 && <div className="sc-tags">{g.tags.map((t) => <span key={t} className={`sc-tag${/솔킬/.test(t) ? " hot" : ""}`}>{t}</span>)}</div>}
        </div>
      </details>
    </li>
  );
}

/** 접힌 줄의 한 사람 — 챔피언·KDA·아이템 작게(전적 사이트의 접힌 줄과 같은 정보 밀도). */
function SummaryLine({ i, name, l }: { i: number; name: string; l: Line }) {
  const champ = championById(l.champId);
  return (
    <span className="sc-sline">
      <span className="sc-pname" style={{ color: `var(--sc-m${i})` }}>{name}</span>
      {champ && <img src={championIconPath(champ)} alt={l.champName} title={l.champName} width={32} height={32} className="sc-schamp" />}
      <b className="sc-num">{l.kills}/<span className="sc-l">{l.deaths}</span>/{l.assists}</b>
      <span className="sc-items small">
        {l.items.slice(0, 6).map((id, k) => <Icon key={k} src={id ? itemIconPath(id) : null} label={id ? itemName(id) : null} size={18} />)}
      </span>
    </span>
  );
}
