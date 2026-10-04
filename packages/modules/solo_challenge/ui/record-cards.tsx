import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { championById, championIconPath } from "@soop-lol/core/lib/contract";
import type { ChallengeView, RecordRow } from "../server/model.ts";
import { challengeHref } from "./paths.ts";
import "./record-cards.css";

const HIGHLIGHTS = ["kills", "solo", "kda"];
const tone = (key: string) => ["deaths", "shortLoss", "streakL"].includes(key) ? "#f19aa9"
  : ["steal", "plates"].includes(key) ? "#7ccbb7"
  : ["long", "shortWin"].includes(key) ? "#a3bce2" : "#d8b58e";
function dateText(iso: string | null) {
  if (!iso) return "";
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}.${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function displayValue(value: string) {
  const main = value.split(" · ")[0];
  const time = main.match(/^(\d+)분 (\d+)초$/);
  if (time) return { number: `${time[1]}:${time[2].padStart(2, "0")}`, unit: "" };
  const number = main.match(/[\d,.]+/)?.[0];
  return number ? { number, unit: main.replace(number, "").trim() } : { number: main, unit: "" };
}
function RecordShell({ record, view, className, children, newTab = false, style }: { record: RecordRow; view: ChallengeView; className: string; children: ReactNode; newTab?: boolean; style?: CSSProperties }) {
  const props = { className, style: { "--sr-tone": tone(record.key), ...style } as CSSProperties, "data-record": record.key };
  return record.matchId ? <a {...props} target={newTab ? "_blank" : undefined} rel={newTab ? "noopener noreferrer" : undefined} href={`${challengeHref(view.def.slug, { tab: "games" })}#g-${record.matchId}`} aria-label={`${record.label}, ${record.value}, ${record.who ?? ""} 경기 보기`}>{children}</a> : <article {...props}>{children}</article>;
}
export function RecordCards({ view }: { view: ChallengeView }) {
  const champOf = (r: RecordRow) => {
    const game = view.games.find((g) => g.matchId === r.matchId);
    const member = view.def.members.findIndex((m) => m.name === r.who);
    const line = member >= 0 ? game?.lines[member] : null;
    return line ? championById(line.champId) : null;
  };
  const highlights = HIGHLIGHTS.flatMap((key) => view.records.filter((r) => r.key === key));
  return <div className="sr-records">
    <div className="sr-highlights">{highlights.map((r) => {
      const champ = champOf(r);
      return <RecordShell key={r.key} record={r} view={view} className="sr-hero">
        {champ && <img className="sr-art" src={`/images/champion-splash/${champ.en}.jpg`} alt="" />}
        <div className="sr-hero-content"><h3>{r.label}</h3><strong>{r.value.split(" · ")[0]}</strong><small>{r.value.split(" · ").slice(1).join(" · ")}</small>
          <div className="sr-hero-owner"><div><b>{r.who ?? "기록 없음"}</b><span>{[r.champ, dateText(r.at), r.note].filter(Boolean).join(" · ")}</span></div>{r.matchId && <ArrowUpRight size={16} />}</div>
        </div>
      </RecordShell>;
    })}</div>
    <LowerRecords view={view} champOf={champOf} />
  </div>;
}

function LowerRecords({ view, champOf }: { view: ChallengeView; champOf: (r: RecordRow) => ReturnType<typeof championById> | null }) {
  const records = (keys: string[]) => keys.flatMap((key) => view.records.filter((r) => r.key === key));
  const extra = (r: RecordRow) => r.key === "multi" ? "더블 이상" : r.value.split(" · ").slice(1).join(" · ");
  const icon = (r: RecordRow) => {
    const champ = champOf(r);
    return champ ? <img src={championIconPath(champ)} alt={r.champ ?? champ.name} loading="lazy" /> : null;
  };
  const value = (r: RecordRow) => {
    const v = displayValue(r.value);
    return <span className="sr-metric"><strong>{v.number}</strong>{v.unit && <small>{v.unit}</small>}</span>;
  };
  const times = records(["shortWin", "shortLoss", "long"]);
  const seconds = (r: RecordRow) => {
    const match = r.value.match(/(\d+)분 (\d+)초/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  };
  const axisMinutes = Math.max(50, Math.ceil(Math.max(0, ...times.map(seconds)) / 600) * 10);
  return <>
    <div className="sr-section-heading"><h3>전체 기록</h3><span>{view.records.filter((r) => !HIGHLIGHTS.includes(r.key)).length}개</span></div>
    <div className="sr-lower">
      <div className="sr-combat-grid">{records(["assists", "dpm", "multi", "spree", "deaths"]).map((r) =>
        <RecordShell key={r.key} record={r} view={view} newTab className="sr-combat">
          <div className="sr-tile-heading"><h3>{r.key === "multi" ? "최다 멀티킬" : r.label}</h3>{icon(r)}</div>
          {value(r)}
          <div className="sr-combat-owner"><div><span>{r.who ?? "기록 없음"}</span><small>{extra(r)}</small></div><small>{[r.champ, dateText(r.at), r.note].filter(Boolean).join(" · ")}</small></div>
        </RecordShell>
      )}</div>
      <div className="sr-middle">
        <section className="sr-time-panel" aria-label="경기 시간 기록">
          <div className="sr-time-heading"><h3>경기 시간</h3><span>0 – {axisMinutes}분</span></div>
          <div className="sr-time-axis"><div className="sr-time-rail" aria-hidden="true" />{times.map((r) => {
            const position = seconds(r) / (axisMinutes * 60) * 100;
            return <RecordShell key={r.key} record={r} view={view} newTab className={`sr-time-marker${r.key === "shortLoss" ? " sr-below" : ""}${position > 85 ? " sr-at-end" : ""}`} style={{ left: `${position}%`, "--sr-tone": r.key === "shortWin" ? "#7ccbb7" : tone(r.key) } as CSSProperties}>
              <span className="sr-time-detail">{icon(r)}<span>{[r.who, r.champ, extra(r)].filter(Boolean).join(" · ")}</span></span>
              <h4>{r.label}</h4>{value(r)}<span className="sr-time-dot" aria-hidden="true" />
            </RecordShell>;
          })}</div>
          <div className="sr-time-ticks" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i}>{axisMinutes * i / 5}{i === 5 ? "분" : ""}</span>)}</div>
        </section>
        <div className="sr-streak-grid">{records(["streakW", "streakL"]).map((r) =>
          <RecordShell key={r.key} record={r} view={view} className={`sr-streak${r.key === "streakL" ? " sr-loss" : ""}`}>
            <span className="sr-watermark" aria-hidden="true">{r.key === "streakL" ? "LOSE" : "WIN"}</span>
            <div className="sr-streak-heading"><h3>{r.label}</h3><span>듀오 전체</span></div>
            {value(r)}
            <div className="sr-streak-owner"><span className="sr-avatars">{view.def.members.map((m) => <img key={m.streamer} src={`/images/challenge-members/${m.streamer}.jpg`} alt="" width={20} height={20} />)}</span><span>{view.def.members.map((m) => m.name).join(" · ")} 함께</span></div>
          </RecordShell>
        )}</div>
      </div>
      <div className="sr-object-grid">{records(["steal", "plates", "perfect"]).map((r) => {
        const empty = r.key === "perfect" && displayValue(r.value).number === "0";
        return <RecordShell key={r.key} record={r} view={view} newTab className={`sr-object${empty ? " sr-unachieved" : ""}`}>
          {!empty && icon(r)}<div className="sr-object-copy"><h3>{r.key === "perfect" ? <>무결점 판 <span>노데스 승리</span></> : r.label}</h3><small>{empty ? "아직 달성한 경기 없음" : [r.who, r.champ, dateText(r.at), r.note].filter(Boolean).join(" · ")}</small></div>{value(r)}
        </RecordShell>;
      })}</div>
    </div>
  </>;
}
