import Link from "next/link";
import { ChevronDown, Crosshair } from "lucide-react";
import type { CSSProperties } from "react";
import {
  championById, championIconPath, itemIconPath, itemName, profileHref,
  runeIconPath, runeName, spellIconPath, spellName,
} from "@soop-lol/core/lib/contract";
import type { ChallengeView, GameRow, Line, LineupSlot } from "../server/index.ts";
import "./match-card.css";

const POSITION: Record<string, string> = { TOP: "탑", JUNGLE: "정글", MIDDLE: "미드", BOTTOM: "원딜", UTILITY: "서포터" };
const number = (n: number) => n.toLocaleString("ko-KR");
const ratio = (line: Pick<Line, "kills" | "deaths" | "assists">) => ((line.kills + line.assists) / Math.max(1, line.deaths)).toFixed(2);
const playerStyle = (i: number) => ({ "--player": `var(--sc-m${i})` }) as CSSProperties;
function dateText(iso: string) {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}.${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function BuildIcon({ src, label, round = false }: { src: string | null; label: string | null; round?: boolean }) {
  return src ? <img src={src} alt={label ?? ""} title={label ?? undefined} width={28} height={28} className={round ? "is-round" : undefined} loading="lazy" />
    : <span className="cm-item-empty" aria-label="빈 아이템 칸" />;
}
function Items({ line, ward = false }: { line: Line; ward?: boolean }) {
  const items = Array.from({ length: 6 }, (_, i) => line.items[i] ?? 0);
  return <span className="cm-items">
    {items.map((id, i) => <BuildIcon key={i} src={id ? itemIconPath(id) : null} label={id ? itemName(id) : null} />)}
    {ward && <span className="cm-ward"><BuildIcon src={line.items[6] ? itemIconPath(line.items[6]) : null} label={line.items[6] ? itemName(line.items[6]) : null} round /></span>}
  </span>;
}
function Kda({ line }: { line: Pick<Line, "kills" | "deaths" | "assists"> }) {
  return <span className="cm-kda"><b>{line.kills}</b><i>/</i><b className="cm-deaths">{line.deaths}</b><i>/</i><b>{line.assists}</b></span>;
}
const MVP_CRITERION = "도전자 중 킬+어시스트 최다 · 동률이면 멤버 순서";
function MvpBadge() { return <span className="cm-mvp" title={MVP_CRITERION} aria-label={`MVP: ${MVP_CRITERION}`}>MVP</span>; }
function SummaryPlayer({ view, line, index, mvp }: { view: ChallengeView; line: Line | null; index: number; mvp: boolean }) {
  const member = view.def.members[index];
  const champ = line ? championById(line.champId) : null;
  return <span className={`cm-summary-player${line ? "" : " cm-absent"}`} style={playerStyle(index)}>
    {champ && <span className="cm-portrait-wrap"><img className="cm-portrait" src={championIconPath(champ)} alt={line?.champName} width={42} height={42} loading="lazy" />{mvp && <MvpBadge />}</span>}
    <span className="cm-summary-name"><span className="cm-member-name">{["seokwngud", "kimmingyo"].includes(member.streamer) && <img src={`/images/challenge-members/${member.streamer}.jpg`} alt="" width={14} height={14} loading="lazy" />}<b>{member.name}</b></span><span className="cm-champ-position">{line ? [line.champName, line.position && POSITION[line.position]].filter(Boolean).join(" · ") : "이 경기 미참여"}</span></span>
    {line && <span className="cm-summary-kda"><Kda line={line} /><small>{ratio(line)} KDA</small></span>}
  </span>;
}
function PlayerReport({ view, line, index, seconds, mvp }: { view: ChallengeView; line: Line; index: number; seconds: number; mvp: boolean }) {
  const member = view.def.members[index];
  const champ = championById(line.champId);
  return <article className="cm-player" style={playerStyle(index)} aria-label={`${member.name} 경기 기록`}>
    <div className="cm-player-heading">
      <div className="cm-player-identity">
        {champ && <img src={championIconPath(champ)} alt="" width={56} height={56} loading="lazy" />}
        <div><span className="cm-report-name"><strong>{member.name}</strong>{mvp && <MvpBadge />}</span><span>{line.champName}{line.position && POSITION[line.position] ? ` · ${POSITION[line.position]}` : ""}</span></div>
      </div>
      <div className="cm-player-score"><Kda line={line} /><span><b>{ratio(line)}</b> KDA</span></div>
    </div>
    <div className="cm-metrics">
      <div><span>챔피언 피해량</span><strong>{number(line.damage)}</strong><small>팀 내 {line.damageShare}%</small><span className="cm-meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, line.damageShare))}%` }} /></span></div>
      <div><span>킬 관여율</span><strong>{line.kp}<em>%</em></strong><small>{line.kills + line.assists}킬 관여</small><span className="cm-meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, line.kp))}%` }} /></span></div>
      <div><span>CS</span><strong>{line.cs}</strong><small>분당 {(line.cs / Math.max(1, seconds / 60)).toFixed(1)}</small></div>
    </div>
    <div className="cm-loadout">
      <div className="cm-final-build"><span className="cm-label">최종 아이템</span><Items line={line} ward /></div>
      <div className="cm-spells"><span className="cm-label">주문 · 룬</span><div>
        {line.spells.map((id, i) => <BuildIcon key={i} src={spellIconPath(id)} label={spellName(id)} />)}
        <span className="cm-build-divider" />
        <BuildIcon src={runeIconPath(line.keystone)} label={runeName(line.keystone)} round />
        <BuildIcon src={runeIconPath(line.subStyle)} label={runeName(line.subStyle)} round />
      </div></div>
    </div>
    <div className="cm-player-insights">
      <span><Crosshair size={13} /> 솔로킬 <b>{line.soloKills}</b></span>
      <span>최대 CS 격차 <b>{line.csLead > 0 ? "+" : ""}{line.csLead}</b></span>
    </div>
  </article>;
}
function TeamTable({ team, ours, win }: { team: LineupSlot[]; ours: boolean; win: boolean }) {
  const complete = team.length === 5;
  const totalKills = team.reduce((total, p) => total + p.kills, 0);
  return <div className={`cm-team ${win ? "is-win" : "is-loss"}`}>
    <div className="cm-team-heading"><h4>{ours ? "우리 팀" : "상대 팀"}<span>{win ? "승리" : "패배"}</span></h4>{complete && <span className="cm-team-kills"><b>{totalKills}</b> 킬</span>}</div>
    <table>
      <colgroup><col /><col className="cm-stat-col" /><col className="cm-stat-col" /><col className="cm-stat-col" /><col className="cm-ratio-col" /></colgroup>
      <caption className="cm-sr-only">{ours ? "우리 팀" : "상대 팀"} 선수별 킬, 데스, 어시스트와 KDA</caption>
      <thead><tr><th scope="col">플레이어</th><th scope="col" title="킬">K</th><th scope="col" title="데스">D</th><th scope="col" title="어시스트">A</th><th scope="col">KDA</th></tr></thead>
      <tbody>{team.map((p, i) => {
        const champ = championById(p.champId);
        return <tr key={i} className={p.member != null ? "cm-challenger" : undefined} style={p.member != null ? playerStyle(p.member) : undefined}>
          <td><div className="cm-roster-player">
            {champ && <img src={championIconPath(champ)} alt={champ.name} width={30} height={30} loading="lazy" />}
            <span>{p.slug ? <Link href={profileHref("lol", p.slug)}>{p.name ?? champ?.name ?? "플레이어"}</Link> : <span>{p.name ?? champ?.name ?? "알 수 없음"}</span>}</span>
          </div></td>
          <td>{p.kills}</td><td className="cm-roster-deaths">{p.deaths}</td><td>{p.assists}</td><td className={Number(ratio(p)) >= 3 ? "cm-high-kda" : undefined}>{ratio(p)}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
export function GameCard({ view, g }: { view: ChallengeView; g: GameRow }) {
  const teams = [g.teamId, g.teamId === 100 ? 200 : 100].map((id) => g.lineup.filter((p) => p.teamId === id));
  const duration = `${Math.floor(g.seconds / 60)}:${String(g.seconds % 60).padStart(2, "0")}`;
  // Handoff provisional MVP: highest kills + assists among the challengers; stable ties.
  const mvpIndex = g.lines.reduce((best, line, index) => {
    if (!line) return best;
    const previous = best >= 0 ? g.lines[best] : null;
    return !previous || line.kills + line.assists > previous.kills + previous.assists ? index : best;
  }, -1);
  const mvpLine = g.lines[mvpIndex];
  const mvpChamp = mvpLine ? championById(mvpLine.champId) : null;
  const scores = teams.every((team) => team.length === 5) ? teams.map((team) => team.reduce((sum, p) => sum + p.kills, 0)) : null;
  const summaryTags = g.tags.filter((tag) => /솔킬|솔로킬|멀티킬|더블킬|트리플킬|쿼드라킬|펜타킬/.test(tag));
  return <li id={`g-${g.matchId}`} className={`sc-game cm-match ${g.win ? "win" : "loss"}`}>
    <details>
      <summary className="cm-summary">
        <span className="cm-summary-bg" aria-hidden="true" style={mvpChamp ? { backgroundImage: `url(/images/champion-splash/${mvpChamp.en}.jpg)` } : undefined} />
        <span className="cm-summary-scrim" aria-hidden="true" />
        <span className="cm-result"><span className="cm-result-score"><b>{g.win ? "승리" : "패배"}</b>{scores && <span aria-label={`우리 팀 ${scores[0]}킬, 상대 팀 ${scores[1]}킬`}>{scores[0]} : {scores[1]}</span>}</span><span className="cm-result-time">{dateText(g.at)} · {duration}{g.surrender ? " · 서렌" : ""}</span><span className="cm-summary-tags">{summaryTags.map((tag) => <span key={tag}>{tag}</span>)}</span></span>
        <span className="cm-duo-summary">{view.def.members.map((member, i) => <SummaryPlayer key={member.streamer} view={view} line={g.lines[i] ?? null} index={i} mvp={i === mvpIndex} />)}</span>
        <span className="cm-expand"><ChevronDown size={16} /><span className="cm-collapse-label">접기</span></span>
      </summary>
      <div className="cm-report">
        <div className="cm-duo-reports">{g.lines.map((line, i) => line && <PlayerReport key={i} view={view} line={line} index={i} seconds={g.seconds} mvp={i === mvpIndex} />)}</div>
        {g.tags.length > 0 && <div className="cm-highlights"><span>경기 포인트</span><div>{g.tags.map((tag) => <span key={tag} className={/솔킬|솔로킬/.test(tag) ? "cm-highlight-hot" : undefined}>{tag}</span>)}</div></div>}
        {g.lineup.length > 0 && <div className="cm-scoreboard"><div className="cm-teams">{teams.map((team, i) => <TeamTable key={i} team={team} ours={i === 0} win={i === 0 ? g.win : !g.win} />)}</div></div>}
      </div>
    </details>
  </li>;
}
