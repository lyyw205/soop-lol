"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, LoaderCircle, Search, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import type { FcoPerson } from "@soop-lol/core/lib/db/fconline";
import { profileHref, recordSearchHref } from "@soop-lol/core/lib/site-paths";
import { formatWon } from "@soop-lol/core/lib/metrics/club-value";
import { Avatar } from "@/components/avatar";

export interface HomeClub {
  id: string; name: string; nickname: string; image: string | null; channelId: string | null;
  href: string; value: number; capturedAt: string | null;
  history: { day: string; value: number }[];
  change: { delta: number; pct: number; since: string } | null;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const shortDay = (day: string) => day.slice(5).replace("-", ".");
const normalize = (text: string) => text.replace(/\s/g, "").toLocaleLowerCase("ko-KR");

/** Keep server content visible without JavaScript; animate each element once on entry. */
export function HomeMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const animations: Animation[] = [];
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry, index) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        if (!preference.matches) animations.push(entry.target.animate([
          { opacity: 0, transform: "translateY(22px)" },
          { opacity: 1, transform: "translateY(0)" },
        ], { duration: 650, delay: Math.min(index * 65, 195), easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" }));
      });
    }, { threshold: 0.12 });
    element.querySelectorAll("[data-reveal]").forEach((node) => observer.observe(node));
    const hero = element.querySelector<HTMLElement>(".fh-hero");
    let frame = 0;
    const reset = () => { cancelAnimationFrame(frame); hero?.style.removeProperty("--pointer-x"); hero?.style.removeProperty("--pointer-y"); };
    const move = (event: PointerEvent) => {
      if (preference.matches || event.pointerType !== "mouse" || !hero) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = hero.getBoundingClientRect();
        hero.style.setProperty("--pointer-x", `${((event.clientX - rect.left) / rect.width - 0.5) * 12}px`);
        hero.style.setProperty("--pointer-y", `${((event.clientY - rect.top) / rect.height - 0.5) * 8}px`);
      });
    };
    const preferenceChanged = () => { if (preference.matches) { animations.forEach((a) => a.cancel()); reset(); } };
    hero?.addEventListener("pointermove", move);
    hero?.addEventListener("pointerleave", reset);
    preference.addEventListener("change", preferenceChanged);
    return () => {
      observer.disconnect(); animations.forEach((a) => a.cancel()); reset();
      hero?.removeEventListener("pointermove", move); hero?.removeEventListener("pointerleave", reset);
      preference.removeEventListener("change", preferenceChanged);
    };
  }, []);
  return <div className="fc-home" ref={root}>{children}</div>;
}

export function HomeSearch({ people }: { people: FcoPerson[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [pending, startTransition] = useTransition();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const term = normalize(query);
  const hits = useMemo(() => {
    if (!term) return [];
    return people.filter((p) => [p.name, p.nickname, p.slug, p.channel_id ?? ""].some((s) => normalize(s).includes(term)))
      .sort((a, b) => Number([b.name, b.nickname].some((s) => normalize(s) === term)) - Number([a.name, a.nickname].some((s) => normalize(s) === term)))
      .slice(0, 6);
  }, [people, term]);
  const expanded = open && !!term && !pending;
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div className="fh-search-wrap" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <label className="fh-search-label" htmlFor={id}>스트리머 전적 검색 <ArrowUpRight size={14} aria-hidden="true" /></label>
    <form className="fh-search" role="search" onSubmit={(event) => {
      event.preventDefault();
      const person = hits[cursor];
      if (person || !term) {
        setOpen(false);
        startTransition(() => router.push(person ? profileHref("fconline", person.slug) : recordSearchHref("fconline")));
      } else { input.current?.focus(); setOpen(true); }
    }}>
      <Search className="fh-search-icon" size={22} aria-hidden="true" />
      <input ref={input} id={id} value={query} placeholder="스트리머명 · 감독명 검색" autoComplete="off" spellCheck={false}
        role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-results`}
        aria-activedescendant={expanded && hits[cursor] ? `${id}-option-${cursor}` : undefined}
        onFocus={() => setOpen(true)} onChange={(e) => { setQuery(e.target.value); setCursor(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) { if (e.key === "Enter") e.preventDefault(); return; }
          if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
            e.preventDefault(); setOpen(true);
            setCursor((previous) => (previous + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
          }
        }} />
      <button type="submit" aria-label={pending ? "전적을 불러오는 중" : "전적 검색"} disabled={pending}>
        {pending ? <LoaderCircle className="fh-spinner" size={23} aria-hidden="true" /> : <ArrowRight size={25} aria-hidden="true" />}
      </button>
    </form>
    <div className="fh-search-dropdown" hidden={!expanded}>
      <ul id={`${id}-results`} role="listbox" aria-label="스트리머 검색 결과">
        {hits.map((person, index) => <li key={`${person.id}:${person.nickname}`} id={`${id}-option-${index}`} role="option" aria-selected={cursor === index} onPointerMove={() => setCursor(index)}>
          <Link href={profileHref("fconline", person.slug)} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(false)}>
            <Avatar name={person.name} src={person.image} channelId={person.channel_id} /><span><b>{person.name}</b><small>{person.nickname}</small></span><ArrowUpRight size={19} aria-hidden="true" />
          </Link>
        </li>)}
      </ul>
      {!hits.length && <p className="fh-search-empty" role="status">검색 결과가 없습니다.</p>}
      {!!hits.length && <div className="fh-search-hint"><span>↑ ↓ 선택</span><span>Enter 전적 보기</span></div>}
    </div>
    <span className="fh-sr-only" role="status">{expanded && hits.length ? `${hits.length}개의 검색 결과` : ""}</span>
  </div>;
}

const integerAmount = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const smallAmount = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

function ChangeFigure({ value }: { value: number }) {
  const ref = useRef<HTMLElement>(null);
  const magnitude = Math.abs(value);
  const [scale, unit] = magnitude >= 1e12 ? [1e12, "조"] as const : magnitude >= 1e8 ? [1e8, "억"] as const
    : magnitude >= 1e4 ? [1e4, "만"] as const : [1, "BP"] as const;
  const amount = magnitude / scale;
  const formatter = amount < 10 ? smallAmount : integerAmount;
  const absolute = formatter.format(amount);
  useEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion()) return;
    let frame = 0;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => { cancelAnimationFrame(frame); element.textContent = absolute; };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      if (preference.matches) return;
      const start = performance.now();
      const tick = (now: number) => {
        const progress = Math.min((now - start) / 1050, 1);
        element.textContent = formatter.format(amount * (1 - Math.pow(1 - progress, 4)));
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, { threshold: 0.5 });
    observer.observe(element);
    preference.addEventListener("change", finish);
    return () => { observer.disconnect(); finish(); preference.removeEventListener("change", finish); };
  }, [amount, absolute, formatter]);
  const label = `${value < 0 ? "하락액" : "상승액"} ${formatWon(magnitude)} BP`;
  return <strong className="fh-change-figure" aria-label={label} title={label}>
    <span aria-hidden="true">{value < 0 ? "−" : "+"}<b ref={ref}>{absolute}</b><small>{unit}</small></span>
  </strong>;
}

function ClubChart({ person }: { person: HomeClub }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const series = person.history;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { element.classList.add("is-visible"); observer.disconnect(); }
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (series.length < 2) return null;
  const min = Math.min(...series.map((p) => p.value));
  const max = Math.max(...series.map((p) => p.value));
  const first = new Date(series[0].day).getTime();
  const duration = new Date(series.at(-1)!.day).getTime() - first || 1;
  const points = series.map((p) => ({
    x: 6 + (new Date(p.day).getTime() - first) / duration * 588,
    y: 126 - (p.value - min) / (max - min || 1) * 106,
    ...p,
  }));
  const path = points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const gaps = points.some((p, i) => i > 0 && new Date(p.day).getTime() - new Date(points[i - 1].day).getTime() > 86400000);
  return <div className="fh-chart" ref={ref}>
    <svg viewBox="0 0 600 145" preserveAspectRatio="none" role="img" aria-label={`${person.name} 구단가치: ${series[0].day} ${formatWon(series[0].value)} BP에서 ${series.at(-1)!.day} ${formatWon(series.at(-1)!.value)} BP${gaps ? ", 미수집 구간은 점선" : ""}`}>
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop stopColor="currentColor" stopOpacity=".2" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path className="fh-chart-grid" d="M0 22H600M0 75H600M0 128H600" />
      <g className="fh-chart-drawing">
        <path d={`${path} L594,145 L6,145 Z`} fill={`url(#${id})`} />
        {points.slice(1).map((p, i) => <path key={p.day} d={`M${points[i].x},${points[i].y} L${p.x},${p.y}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" strokeDasharray={new Date(p.day).getTime() - new Date(points[i].day).getTime() > 86400000 ? "5 6" : undefined} />)}
        {points.map((p, i) => <circle key={p.day} cx={p.x} cy={p.y} r={i === points.length - 1 ? 4 : 2.5} fill="currentColor"><title>{`${p.day} · ${formatWon(p.value)} BP`}</title></circle>)}
        <circle className="fh-chart-halo" cx={points.at(-1)!.x} cy={points.at(-1)!.y} r="8" fill="none" stroke="currentColor" strokeOpacity=".3" />
      </g>
    </svg>
    <div className="fh-chart-axis"><time dateTime={series[0].day}>{shortDay(series[0].day)}</time><span>{gaps ? "점선: 미수집 구간" : "구단가치 변화"}</span><time dateTime={series.at(-1)!.day}>{shortDay(series.at(-1)!.day)}</time></div>
  </div>;
}

export function ClubMovers({ up, down }: { up: HomeClub | null; down: HomeClub | null }) {
  const [direction, setDirection] = useState<"up" | "down">(up ? "up" : down ? "down" : "up");
  const person = direction === "up" ? up : down;
  return <div className="fh-mover" data-direction={direction} data-reveal>
    <div className="fh-mover-top"><div className="fh-segment" role="group" aria-label="구단가치 변화 선택">
      <button type="button" aria-pressed={direction === "up"} onClick={() => setDirection("up")}><TrendingUp size={14} aria-hidden="true" />급상승</button>
      <button type="button" aria-pressed={direction === "down"} onClick={() => setDirection("down")}><TrendingDown size={14} aria-hidden="true" />급하락</button>
    </div><span className="fh-mover-period"><span>최근 7일</span><span>{direction === "up" ? "상승액" : "하락액"} 1위</span></span></div>
    {person && person.change ? <div className="fh-mover-body" key={`${direction}:${person.id}`}>
      <Link href={person.href} className="fh-mover-person"><Avatar name={person.name} src={person.image} channelId={person.channelId} /><span><b>{person.name}</b><small>{person.nickname}</small></span></Link>
      <dl className="fh-mover-numbers">
        <div className="fh-mover-stat">
          <dt>7일 {direction === "up" ? "상승액" : "하락액"}</dt>
          <dd className="fh-mover-rate">{person.change.delta < 0 ? "−" : "+"}{Math.abs(person.change.pct).toFixed(1)}%</dd>
          <dd className="fh-mover-stat-value"><ChangeFigure value={person.change.delta} /></dd>
        </div>
        <div className="fh-mover-stat">
          <dt>현재 구단가치</dt>
          <dd className="fh-mover-stat-value"><strong className="fh-current-value" title={`총 구단가치 ${formatWon(person.value)} BP`}>{(person.value / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}<small>억</small></strong></dd>
        </div>
      </dl>
      <ClubChart person={person} />
      <div className="fh-mover-bottom"><span>수집분 {shortDay(person.change.since)} — {shortDay(person.history.at(-1)!.day)}</span><Link href={person.href}>구단 보기 <ArrowRight size={15} aria-hidden="true" /></Link></div>
    </div> : <p className="fh-empty">최근 7일 내 비교 가능한 {direction === "up" ? "상승" : "하락"} 기록이 없습니다.</p>}
  </div>;
}
