import Link from "next/link";
import { ArrowRight, ExternalLink, Trophy, CalendarDays } from "lucide-react";
import type { TournamentSummary } from "../server/tournament.ts";
/**
 * ★ **연출만.** 이 대회는 전용 사진·제목 장식·대진표 배치를 쓴다. 사실(순위·팀장·등급·상금·
 *   안내·출처)은 전부 core DB 에서 온다 — 여기에 사실을 적지 않는다.
 */
export const FEATURED_SLUG = "meljang-2026-geng";
import type { ReactNode } from "react";
export const positions = [
  ["TOP", "TOP"],
  ["JUNGLE", "JGL"],
  ["MIDDLE", "MID"],
  ["BOTTOM", "BOT"],
  ["UTILITY", "SUP"],
] as const;
export const tournamentHref = (slug: string, tab?: string) =>
  `/tournaments/${encodeURIComponent(slug)}${tab && tab !== "overview" ? `?tab=${tab}` : ""}`;
export const dotted = (date: string | null) =>
  date ? date.replaceAll("-", ".") : "일정 미정";
export const period = (e: TournamentSummary) =>
  `${dotted(e.start)}${e.end && e.end !== e.start ? ` ~ ${dotted(e.end)}` : ""}`;
export const categoryLabel = (e: TournamentSummary) =>
  e.category === "meljang" ? "멸망전" : e.category === "ck" ? "CK" : "이벤트 매치";
export function SafeExternal({
  href,
  children,
  className = "",
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
}) {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ExternalLink size={13} />
    </a>
  );
}
export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="tp-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function TournamentHero({
  event,
  compact = false,
  links = [],
}: {
  event: TournamentSummary;
  compact?: boolean;
  /** 대회 추가 링크. 있으면 첫 번째(보통 공식 다시보기)를 대표 버튼으로 쓴다. */
  links?: { label: string; url: string }[];
}) {
  const featured = event.slug === FEATURED_SLUG;
  return (
    <section
      className={`tp-hero ${compact ? "tp-hero-compact" : ""} ${featured ? "tp-hero-featured" : ""}`}
      style={
        {
          "--tp-photo": `url('${featured ? "/images/tournaments/meljang-2026-geng.jpg" : "/images/arena/LeeSin.jpg"}')`,
        } as React.CSSProperties
      }
    >
      <div className="tp-hero-photo" aria-hidden="true" />
      <div className="tp-hero-copy">
        <div className="tp-eyebrow">
          <span className="tp-edition">
            {event.start?.slice(2, 4) ?? "LOL"}
          </span>
          {compact
            ? (event.organizer ?? "LOL")
            : `${event.organizer ?? "LOL"} ${featured ? "× Gen.G" : ""}`}
          <span className="tp-chip">{categoryLabel(event)}</span>
        </div>
        {compact ? (
          <h2>
            <Link href={tournamentHref(event.slug)}>{event.name}</Link>
          </h2>
        ) : (
          <h1>
            {featured ? (
              <>
                <span>2026 LoL</span> 멸망전 <em>with Gen.G</em>
              </>
            ) : (
              event.name
            )}
          </h1>
        )}
        <p className="tp-hero-date">
          <CalendarDays size={13} />
          {period(event)}
          {event.dateFromMatches && <small>경기 기록 기준</small>}
        </p>
        {!compact && (
          <SafeExternal
            href={links[0]?.url ?? event.sourceUrl}
            className="tp-hero-source"
          >
            {links[0]?.label ?? "대회 출처"}
          </SafeExternal>
        )}
      </div>
      {compact ? (
        <Link href={tournamentHref(event.slug)} className="tp-hero-cta">
          대회 기록 보기 <ArrowRight size={17} />
        </Link>
      ) : (
        event.winner && (
          <div className="tp-champion-stamp">
            <span>CHAMPIONS</span>
            <strong>
              <Trophy />
              {event.winner}
            </strong>
            {featured && <small>패자조를 넘어, 마침내 정상으로.</small>}
          </div>
        )
      )}
      {featured && !compact && (
        <span className="tp-photo-credit">사진 © SOOP</span>
      )}
    </section>
  );
}
