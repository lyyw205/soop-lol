/**
 * FC 대회 화면의 공통 조각. 롤 대회 화면(tournaments 모듈)의 배치를 따르되 모듈끼리 import 할 수
 * 없으므로(verify:modules 3조) 같은 모양을 이 모듈 안에 따로 둔다. 클래스는 ft- 접두사다.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, CalendarDays, ExternalLink, Trophy } from "lucide-react";
import { kstDotted, kstYear, type FcoEvent, type FcoGame } from "@soop-lol/core/lib/contract";
import { Avatar } from "../../../ui/avatar.tsx";
import { kindLabel, type Entrant } from "./model.ts";
import { tournamentDetailHref } from "./paths.ts";

export const DETAIL_TABS = [
  ["overview", "개요"],
  ["bracket", "대진표"],
  ["matches", "경기"],
  ["players", "참가자"],
  ["records", "기록실"],
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number][0];

export const eventHref = (slug: string, tab?: string) =>
  tournamentDetailHref(slug, tab && tab !== "overview" ? { tab } : undefined);

const timeFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
export const kstTime = (at: string) => timeFormat.format(new Date(at));

/** 대회 연도(KST). ★ 드라이버는 timestamptz 를 타입 선언(string)과 달리 Date 로 돌려준다 — 문자열처럼 자르지 않는다. */
export function eventYear(event: FcoEvent, games: FcoGame[]): string | null {
  const at = event.starts_at ?? games[0]?.played_at;
  return at ? String(kstYear(new Date(at))) : null;
}

/** 대회 기간. 대회에 날짜가 없으면 경기 기록에서 잡고, 그 사실을 함께 돌려준다. */
export function eventPeriod(event: FcoEvent, games: FcoGame[]): { text: string; fromMatches: boolean } {
  const start = event.starts_at ?? games[0]?.played_at ?? null;
  const end = event.ends_at ?? games.at(-1)?.played_at ?? null;
  if (!start) return { text: "일정 미정", fromMatches: false };
  const a = kstDotted(new Date(start)), b = end ? kstDotted(new Date(end)) : a;
  return { text: a === b ? a : `${a} ~ ${b}`, fromMatches: event.starts_at == null };
}

/** 경기가 열린 시간대(KST). 대회 일정이 아니라 기록된 경기의 처음·끝이다. */
export function playedWindow(games: FcoGame[]): string | null {
  if (!games.length) return null;
  return `${kstTime(games[0].played_at)} ~ ${kstTime(games.at(-1)!.played_at)}`;
}

export function SafeExternal({ href, children, className = "" }: { href: string | null; children: ReactNode; className?: string }) {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return <a href={href} className={className} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={13} /></a>;
}

export function SectionHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="ft-heading">
    <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
    {action}
  </div>;
}

export function Panel({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`ft-panel ${className}`}><h2>{title}</h2>{children}</section>;
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="ft-facts">{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}

export function Person({ entrant, size = "md" }: { entrant: Pick<Entrant, "name" | "image" | "channelId">; size?: "sm" | "md" | "lg" }) {
  return <span className={`ft-person-photo ft-person-${size}`}><Avatar name={entrant.name} src={entrant.image} channelId={entrant.channelId} /></span>;
}

export interface HeroNumbers { people: number; games: number; goals: number }

export function TournamentHero({ event, games, numbers, compact = false, people = [], champion = null }: {
  event: FcoEvent;
  games: FcoGame[];
  numbers: HeroNumbers;
  compact?: boolean;
  /** 대진으로 정해진 우승자(공식 발표 또는 규칙 계산). 없으면 안 보인다 */
  champion?: { name: string } | null;
  /** 목록의 LATEST 카드에서만 쓴다 — 참가자 얼굴 줄 */
  people?: Entrant[];
}) {
  const period = eventPeriod(event, games);
  const year = eventYear(event, games)?.slice(2);
  return <section className={`ft-hero ${compact ? "ft-hero-compact" : ""}`}>
    <div className="ft-hero-pitch" aria-hidden="true" />
    <div className="ft-hero-copy">
      <div className="ft-eyebrow">
        <span className="ft-edition">{year ?? "FC"}</span>
        {event.organizer ?? "FC ONLINE"}
        <span className="ft-chip">{kindLabel(event.kind)}</span>
        {compact && champion && <span className="ft-chip ft-chip-champion"><Trophy size={10} />우승 {champion.name}</span>}
      </div>
      {compact
        ? <h2><Link href={eventHref(event.slug)}>{event.name}</Link></h2>
        : <h1>{event.name}</h1>}
      <p className="ft-hero-date">
        <CalendarDays size={13} />{period.text}
        {period.fromMatches && <small>경기 기록 기준</small>}
      </p>
      {compact && people.length > 0 && <div className="ft-hero-faces" aria-label="참가자">
        {people.slice(0, 10).map((p) => <Person key={p.key} entrant={p} size="sm" />)}
        <small>{people.map((p) => p.name).join(" · ")}</small>
      </div>}
      {!compact && <SafeExternal href={event.source_url} className="ft-hero-source">대회 출처</SafeExternal>}
    </div>
    {champion && <div className="ft-hero-champion"><span>CHAMPION</span><strong><Trophy size={18} />{champion.name}</strong></div>}
    <dl className="ft-hero-numbers">
      <div><dt>참가</dt><dd>{numbers.people}<small>명</small></dd></div>
      <div><dt>경기</dt><dd>{numbers.games}<small>판</small></dd></div>
      <div><dt>골</dt><dd>{numbers.goals}<small>골</small></dd></div>
    </dl>
    {compact && <Link href={eventHref(event.slug)} className="ft-hero-cta">대회 기록 보기 <ArrowRight size={17} /></Link>}
  </section>;
}
