"use client";
import type { FcoClubAccountSummary } from "@soop-lol/core/lib/contract";

export function TeamColorIcons({ observation }: { observation: FcoClubAccountSummary["teamColors"] }) {
  if (!observation?.colors.length) return <span className="cv-muted" title="공식 국가·클럽 팀컬러 미확인">—</span>;
  const maxPlayers = Math.max(...observation.colors.map(color => color.players));
  const colors = observation.colors.filter(color => color.players === maxPlayers);
  const stamp = new Date(Date.parse(observation.sourceAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ") + " KST";
  return <span className="cv-team-icons">{colors.map(color => {
    const label = `${color.name} · ${color.players}명 · ${observation.source === "profile-squad" ? `공식 프로필 ${observation.slot ?? ""} · ${stamp} 조회` : `최근 공식 1대1 · ${stamp} 기준`}`;
    return <span className="cv-team-icon" key={`${color.kind}:${color.id}`} tabIndex={0} title={label} aria-label={label}>
      <img src={color.icon} alt={color.name} width={26} height={26} loading="lazy" referrerPolicy="no-referrer"
        onError={e => { e.currentTarget.hidden = true; e.currentTarget.nextElementSibling?.removeAttribute("hidden"); }} />
      <span hidden className="cv-team-fallback">{color.name}</span>
    </span>;
  })}</span>;
}
