"use client";
/**
 * FC 팀컬러 아이콘(공식 클럽 엠블럼·국기). 가장 많은 선수가 속한 팀컬러만 보인다 — 동률이면 모두.
 * 구단가치 모듈(fc_club_value)과 같은 규칙이다. 모듈끼리는 import 할 수 없어(verify:modules 3조) 공용 UI 에 둔다.
 */
import type { FcoClubAccountSummary } from "@soop-lol/core/lib/contract";
import "./team-colors.css";

const kst = (iso: string) => new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ") + " KST";

export function TeamColorIcons({ observation, size = 24 }: { observation: FcoClubAccountSummary["teamColors"]; size?: number }) {
  if (!observation?.colors.length) return <span className="fct-none" title="공식 국가·클럽 팀컬러 미확인">—</span>;
  const most = Math.max(...observation.colors.map((c) => c.players));
  const colors = observation.colors.filter((c) => c.players === most);
  const where = observation.source === "profile-squad"
    ? `공식 프로필 ${observation.slot ?? ""} · ${kst(observation.sourceAt)} 조회`
    : `최근 공식 1대1 · ${kst(observation.sourceAt)} 기준`;
  return <span className="fct-icons">{colors.map((c) => {
    const label = `${c.name} · ${c.players}명 · ${where}`;
    return <span className="fct-icon" key={`${c.kind}:${c.id}`} tabIndex={0} title={label} aria-label={label}>
      <img src={c.icon} alt={c.name} width={size} height={size} loading="lazy" referrerPolicy="no-referrer"
        onError={(e) => { e.currentTarget.hidden = true; e.currentTarget.nextElementSibling?.removeAttribute("hidden"); }} />
      <span hidden className="fct-fallback">{c.name}</span>
    </span>;
  })}</span>;
}
