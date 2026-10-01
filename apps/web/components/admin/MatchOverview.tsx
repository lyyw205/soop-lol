"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { OverviewParticipant, OverviewSeriesRow, OverviewSetDetail } from "@soop-lol/core/lib/db/match-overview";
import { isStandaloneSet, setLabel } from "@soop-lol/core/lib/metrics/set-label";
import { championById, championIconPath } from "@soop-lol/core/lib/riot/champions";
import { POSITIONS, POSITION_LABEL, type Position } from "@soop-lol/core/lib/riot/types";
import { kstPlayedAt } from "@soop-lol/core/lib/time";
import { profileHref } from "@soop-lol/core/lib/site-paths";

import { loadOverviewSetsAction, toggleOverviewReviewAction } from "@/app/admin/overview/actions";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";

type Side = 100 | 200;
const sideName = (set: { blue_team: string | null; red_team: string | null }, side: Side) =>
  (side === 100 ? set.blue_team : set.red_team) ?? (side === 100 ? "1팀(블루)" : "2팀(레드)");

/** 시리즈 스코어. 세트마다 진영이 바뀌므로 팀 이름으로 센다 — 이름이 없으면 셀 수 없다. */
function score(series: OverviewSeriesRow): string | null {
  if (series.sets.some(s => !s.blue_team || !s.red_team)) return null;
  const wins = new Map<string, number>();
  for (const s of series.sets) {
    for (const team of [s.blue_team!, s.red_team!]) if (!wins.has(team)) wins.set(team, 0);
    const w = s.winning_team === 100 ? s.blue_team! : s.winning_team === 200 ? s.red_team! : null;
    if (w) wins.set(w, wins.get(w)! + 1);
  }
  return [...wins.entries()].map(([team, n]) => `${team} ${n}`).join(" : ");
}

const duration = (sec: number | null) => sec == null ? null : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const Missing = () => <span className="text-amber-300">—</span>;

/** 대회 접기 상태를 저장한다. 키는 위치가 아니라 대회 이름 — 목록 순서가 바뀌어도 엉뚱한 대회가 접히지 않는다. */
const FOLD_STORAGE_KEY = "ck-overview-collapsed-events";
function loadFoldedFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLD_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

/**
 * 스크롤 위치는 주소별로 따로 둔다(분류·미검수 필터가 다르면 다른 화면이다).
 * 새로고침에서만 살아남으면 되므로 sessionStorage — 접기 상태(오래 유지하고 싶은 설정)와는 성격이 다르다.
 */
const scrollStorageKey = () => `ck-overview-scroll:${location.pathname}${location.search}`;

/**
 * 실제로 스크롤되는 요소를 찾는다. `window` 가 아니다 — 어드민 레이아웃(AdminShell)이
 * 화면 폭에 따라 `.admin-content` 또는 `.admin-workspace` 를 스크롤 컨테이너로 쓴다
 * (admin.css 768px·1080px 분기). `document.scrollingElement` 는 좁은 화면(모바일)용 fallback.
 */
function getScrollEl(): Element | null {
  const candidates = [document.querySelector(".admin-content"), document.querySelector(".admin-workspace"), document.scrollingElement]
    .filter((el): el is Element => el != null);
  return candidates.find(el => el.scrollHeight > el.clientHeight + 1) ?? candidates[0] ?? null;
}

export function MatchOverview({ series }: { series: OverviewSeriesRow[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sets, setSets] = useState<Map<string, OverviewSetDetail[]>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [loading, startLoading] = useTransition();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  // 서버 렌더와 맞추려고 처음엔 빈 채로 시작하고, 마운트 후 저장된 값으로 맞춘다(하이드레이션 불일치 방지).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [foldReady, setFoldReady] = useState(false);

  // useLayoutEffect — 페인트 전에 접힌 상태를 반영해야 화면 높이가 접힌 채로 확정된다.
  // useEffect 로 하면 "전부 펼친 모습"이 한 프레임 그려진 뒤 접혀서, 그 사이 스크롤 위치가 튄다.
  useLayoutEffect(() => { setCollapsed(loadFoldedFromStorage()); setFoldReady(true); }, []);
  useEffect(() => {
    if (!foldReady) return;
    try { localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify([...collapsed])); } catch { /* 무시 — 접기는 편의 기능일 뿐 */ }
  }, [collapsed, foldReady]);

  // 스크롤 위치 복원 — 접기 상태가 화면에 반영된 뒤(foldReady) 여야 높이가 확정돼 있다.
  // 한 번만 한다: 사용자가 나중에 직접 접었다 펴도 그때마다 다시 스크롤시키면 안 된다.
  useLayoutEffect(() => {
    if (!foldReady) return;
    try {
      const saved = sessionStorage.getItem(scrollStorageKey());
      const el = saved != null ? getScrollEl() : null;
      if (el) el.scrollTop = Number(saved);
    } catch { /* 무시 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldReady]);

  // 스크롤할 때마다(rAF 로 묶어서) 위치를 저장 — 새로고침 순간의 위치가 아니라 마지막으로 본 위치를 남긴다.
  // 실제 스크롤 컨테이너가 화면 폭에 따라 달라지므로 후보 전부에 리스너를 건다.
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const el = getScrollEl();
        if (el) { try { sessionStorage.setItem(scrollStorageKey(), String(el.scrollTop)); } catch { /* 무시 */ } }
        ticking = false;
      });
    };
    const targets = [document.querySelector(".admin-content"), document.querySelector(".admin-workspace"), window]
      .filter((t): t is Element | typeof window => t != null);
    targets.forEach(t => t.addEventListener("scroll", onScroll, { passive: true }));
    return () => targets.forEach(t => t.removeEventListener("scroll", onScroll));
  }, []);

  const update = <T,>(setter: (fn: (m: Map<string, T>) => Map<string, T>) => void, key: string, value: T | undefined) =>
    setter(m => { const next = new Map(m); if (value === undefined) next.delete(key); else next.set(key, value); return next; });

  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) { next.delete(key); setOpen(next); return; }
    next.add(key); setOpen(next);
    if (sets.has(key)) return;
    setLoadingKey(key);
    startLoading(async () => {
      try { update(setSets, key, await loadOverviewSetsAction(key)); update(setErrors, key, undefined); }
      catch (e) { update(setErrors, key, e instanceof Error ? e.message : String(e)); }
    });
  };

  const toggleReview = async (key: string, set: OverviewSetDetail) => {
    const res = await toggleOverviewReviewAction(key, set.match_id, !set.review_completed_at, set.review_version);
    update(setSets, key, res.sets);
    update(setErrors, key, res.ok ? undefined : res.message);
  };

  // 목록은 이미 대회 단위로 붙어서 온다(listOverviewSeries 의 정렬). 이어지는 같은 대회를 한 묶음으로.
  const groups: { id: string; name: string | null; kind: string; series: OverviewSeriesRow[] }[] = [];
  for (const s of series) {
    const last = groups.at(-1);
    if (last && last.name === s.event_name) last.series.push(s);
    else groups.push({ id: `${groups.length}:${s.event_name ?? ""}`, name: s.event_name, kind: s.kind, series: [s] });
  }
  // 접기 상태의 키는 대회 이름이다(g.id 는 목록 위치를 포함해 새로고침마다 안 바뀐다는 보장이 없다).
  const foldKey = (g: { name: string | null }) => g.name ?? "";
  const toggleGroup = (g: { name: string | null }) => setCollapsed(c => {
    const key = foldKey(g);
    const next = new Set(c); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });

  return <>
    {groups.length > 1 && <p className="mb-2 flex justify-end gap-3 text-xs">
      <button type="button" className="text-ink-400 hover:text-accent-400" onClick={() => setCollapsed(new Set(groups.map(foldKey)))}>대회 모두 접기</button>
      <button type="button" className="text-ink-400 hover:text-accent-400" onClick={() => setCollapsed(new Set())}>대회 모두 펼치기</button>
    </p>}
    <div className="overview-groups">
    {groups.map(g => {
      const folded = collapsed.has(foldKey(g));
      const setCount = g.series.reduce((n, s) => n + s.sets.length, 0);
      const done = g.series.reduce((n, s) => n + s.sets.filter(x => x.completed).length, 0);
      return <section key={g.id} className="overview-group" data-folded={folded || undefined}>
        <button type="button" className="overview-event" aria-expanded={!folded} onClick={() => toggleGroup(g)}>
          {folded ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
          <span className="overview-event-kind">{EVENT_KIND_LABEL[g.kind] ?? g.kind}</span>
          <span className="overview-event-name">{g.name ?? "대회 미연결"}</span>
          <span className="overview-event-meta">시리즈 {g.series.length} · 세트 {setCount}</span>
          <span className={`overview-series-review ${done === setCount ? "text-win" : done ? "text-amber-300" : "text-ink-400"}`}>검수 {done}/{setCount}</span>
        </button>
        {!folded && <ul aria-label={`${g.name ?? "대회 미연결"} 경기`}>
          {g.series.map(s => <SeriesItem key={s.key} s={s} isOpen={open.has(s.key)} onToggle={() => toggle(s.key)}
            sets={sets.get(s.key)} error={errors.get(s.key)} loading={loading && loadingKey === s.key}
            onToggleReview={set => toggleReview(s.key, set)} />)}
        </ul>}
      </section>;
    })}
    </div>
  </>;
}

function SeriesItem({ s, isOpen, onToggle, sets, error, loading, onToggleReview }: {
  s: OverviewSeriesRow; isOpen: boolean; onToggle: () => void; sets?: OverviewSetDetail[]; error?: string; loading: boolean;
  onToggleReview: (set: OverviewSetDetail) => Promise<void>;
}) {
  const done = s.sets.filter(x => x.completed).length;
  const sc = score(s);
  const subs = sets ? substitutions(sets) : null;
  return <li className="overview-series" data-open={isOpen || undefined}>
    <button type="button" className="overview-series-head" aria-expanded={isOpen} onClick={onToggle}>
      {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      <span className="overview-series-date">{kstPlayedAt(new Date(s.first_played), s.game_creation_precision)}</span>
      <span className="overview-series-round">{s.round_label ?? (s.sets.length === 1 && isStandaloneSet(s.sets[0].match_id, s.key) ? "단판" : "라운드 미기재")}</span>
      <span className="overview-series-score">{sc ?? <span className="text-ink-500">팀 이름 없음</span>}</span>
      <span className="overview-series-meta">
        {s.best_of && s.best_of > 1 && <span>{s.best_of}판 {Math.ceil(s.best_of / 2)}선승 · </span>}
        <span>{s.sets.length}세트</span>
      </span>
      <span className={`overview-series-review ${done === s.sets.length ? "text-win" : done ? "text-amber-300" : "text-ink-400"}`}>
        검수 {done}/{s.sets.length}
      </span>
    </button>
    {isOpen && <div className="overview-sets">
      {error && <p role="alert" className="text-xs text-lose">{error}</p>}
      {!sets
        ? <p className="text-xs text-ink-400">{loading ? "불러오는 중…" : "세트를 불러오지 못했습니다."}</p>
        : sets.map(set => <SetCard key={set.match_id} series={s} set={set} subs={subs!.get(set.match_id)}
          onToggleReview={() => onToggleReview(set)} />)}
    </div>}
  </li>;
}

/** 선수를 세트 사이에서 같은 사람으로 보는 기준. 스트리머 연결이 우선, 없으면 화면 이름. */
const personKey = (p: OverviewParticipant) => p.streamer_slug ? `s:${p.streamer_slug}` : p.observed_name ? `o:${p.observed_name.trim()}` : null;

/**
 * 직전 세트와 비교해 **새로 들어온 선수**(교체)를 찾는다. 세트 id → 참가자 번호 집합.
 *
 * ★ 진영(블루/레드)은 세트마다 바뀌므로 진영으로 팀을 잇지 않는다.
 *   팀 이름이 있으면 이름으로, 없으면(CK) 직전 세트 로스터와 더 많이 겹치는 쪽을 같은 팀으로 본다.
 *   이름 없는 팀끼리 겹침이 같으면(로스터를 통째로 바꿈) 판단하지 않는다 — 없는 교체를 지어내지 않는다.
 */
function substitutions(sets: OverviewSetDetail[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let prev: { name: string | null; roster: Set<string> }[] | null = null;
  for (const set of sets) {
    const teams = ([100, 200] as const).map(side => {
      const players = set.participants.filter(p => p.team_id === side);
      return { name: side === 100 ? set.blue_team : set.red_team, players,
        roster: new Set(players.map(personKey).filter((k): k is string => k != null)) };
    });
    const marked = new Set<number>();
    if (prev) {
      const overlap = (a: Set<string>, b: Set<string>) => [...a].filter(k => b.has(k)).length;
      for (const team of teams) {
        const before = team.name && prev.some(t => t.name === team.name)
          ? prev.find(t => t.name === team.name)!
          : (() => {
            const [x, y] = prev!.map(t => overlap(team.roster, t.roster));
            return x === y ? null : prev![x > y ? 0 : 1];
          })();
        if (!before) continue;
        for (const p of team.players) {
          const k = personKey(p);
          if (k && !before.roster.has(k)) marked.add(p.participant_id);
        }
      }
    }
    out.set(set.match_id, marked);
    prev = teams;
  }
  return out;
}

function SetCard({ series, set, subs, onToggleReview }: {
  series: OverviewSeriesRow; set: OverviewSetDetail; subs?: Set<number>; onToggleReview: () => Promise<void>;
}) {
  const [pending, startPending] = useTransition();
  const label = setLabel({ standalone: isStandaloneSet(set.match_id, series.key), best_of: series.best_of,
    set_order_known: series.set_order_known, series_game_no: set.series_game_no });
  const completed = !!set.review_completed_at;
  const blue = set.participants.filter(p => p.team_id === 100);
  const red = set.participants.filter(p => p.team_id === 200);
  const rows = laneRows(blue, red);
  const unlinked = set.participants.filter(p => !p.streamer_slug).length;
  // 승패는 색으로만 말한다. 승자를 모르면 양쪽 다 무색이다.
  const tone = (side: Side) => set.winning_team == null ? "" : set.winning_team === side ? "is-win" : "is-lose";
  return <article className="overview-set">
    <header className="overview-set-head">
      <b className="text-ink-200">{label}</b>
      <span>{kstPlayedAt(new Date(set.game_creation), set.game_creation_precision)}</span>
      <span>{duration(set.game_duration) ?? "시간 미상"}</span>
      {set.winning_team == null && <span className="text-amber-300">승자 미정</span>}
      {set.visibility === "hidden" && <span className="text-amber-300">공개에서 뺌</span>}
      {!!subs?.size && <span className="overview-flag is-sub">교체 {subs.size}명</span>}
      {unlinked > 0 && <span className="overview-flag is-unlinked">미연결 {unlinked}명</span>}
      <button type="button" disabled={pending} onClick={() => startPending(onToggleReview)}
        aria-label={completed ? "미검수로 변경" : "검수 완료로 표시"}
        className={`ck-review-completion-button ml-auto rounded border px-1.5 text-[11px] hover:border-accent-400 disabled:opacity-50 ${completed ? "is-complete" : "is-pending"}`}>
        {pending ? "저장 중" : completed ? "검수 완료" : "미검수"}
      </button>
      <Link href={`/admin/ck/match/${encodeURIComponent(set.match_id)}`} className="hover:text-accent-400" title="검수 화면에서 열기">검수 →</Link>
    </header>
    <table className="overview-match">
      <colgroup><col /><col className="c-champ" /><col className="c-kda" /><col className="c-lane" /><col className="c-kda" /><col className="c-champ" /><col /></colgroup>
      <thead><tr>
        <TeamHead side={100} name={sideName(set, 100)} players={blue} tone={tone(100)} />
        <th scope="col" className="c-lane"><span className="sr-only">라인</span></th>
        <TeamHead side={200} name={sideName(set, 200)} players={red} tone={tone(200)} />
      </tr></thead>
      <tbody>
        {rows.map(({ lane, b, r }, i) => {
          return <tr key={i}>
            <PlayerCells p={b} tone={tone(100)} sub={!!b && !!subs?.has(b.participant_id)} />
            <td className="c-lane">{lane ? POSITION_LABEL[lane as Position] ?? lane : <Missing />}</td>
            <PlayerCells p={r} tone={tone(200)} sub={!!r && !!subs?.has(r.participant_id)} mirror />
          </tr>;
        })}
      </tbody>
    </table>
  </article>;
}

/**
 * 같은 라인끼리 한 줄에 마주 세운다. 한쪽에 그 라인이 없으면 그 칸은 비운다 —
 * 순번으로 짝지으면 라인이 빠진 팀에서 맞라인이 통째로 밀린다.
 * 라인이 없거나 한 팀에 겹치는 자리는 맨 아래에 따로 모은다(라인 칸 `—`).
 */
type LaneRow = { lane: string | null; b?: OverviewParticipant; r?: OverviewParticipant };
function laneRows(blue: OverviewParticipant[], red: OverviewParticipant[]): LaneRow[] {
  const byId = (a: OverviewParticipant, b: OverviewParticipant) => a.participant_id - b.participant_id;
  const rest = { b: [...blue].sort(byId), r: [...red].sort(byId) };
  const take = (list: OverviewParticipant[], lane: string) => {
    const i = list.findIndex(p => p.team_position === lane);
    return i < 0 ? undefined : list.splice(i, 1)[0];
  };
  const rows: LaneRow[] = POSITIONS.map(lane => ({ lane, b: take(rest.b, lane), r: take(rest.r, lane) }));
  for (let i = 0; i < Math.max(rest.b.length, rest.r.length); i++) rows.push({ lane: null, b: rest.b[i], r: rest.r[i] });
  return rows;
}

const kdaText = (p: OverviewParticipant) => p.kills == null || p.deaths == null || p.assists == null
  ? <>{p.kills ?? <Missing />} / {p.deaths ?? <Missing />} / {p.assists ?? <Missing />}</>
  : `${p.kills} / ${p.deaths} / ${p.assists}`;

function TeamHead({ side, name, players, tone }: { side: Side; name: string; players: OverviewParticipant[]; tone: string }) {
  const sum = (k: "kills" | "deaths" | "assists") => players.reduce((n, p) => n + (p[k] ?? 0), 0);
  const missing = players.filter(p => p.kills == null || p.deaths == null || p.assists == null).length;
  const total = <span className="c-kda" title={missing ? `${missing}명 KDA 미입력 — 합계가 모자랍니다` : "KDA 총합"}>
    {missing === players.length ? <Missing /> : <>{sum("kills")} / {sum("deaths")} / {sum("assists")}{missing > 0 && <span className="text-amber-300">*</span>}</>}
  </span>;
  const team = <span className="overview-team-name">{name}{players.length < 5 && <span className="text-amber-300"> ({players.length}/5)</span>}</span>;
  return <th scope="colgroup" colSpan={3} className={`${tone} ${side === 200 ? "is-mirror" : ""}`}>
    <span className="overview-team-head">{side === 100 ? <>{team}{total}</> : <>{total}{team}</>}</span>
  </th>;
}

function PlayerCells({ p, tone, sub, mirror = false }: { p: OverviewParticipant | undefined; tone: string; sub: boolean; mirror?: boolean }) {
  if (!p) return <td colSpan={3} className={tone} />;
  const champion = p.champion_id > 0 ? championById(p.champion_id) : null;
  const flags = [sub && "직전 세트에 없던 선수 — 교체", !p.streamer_slug && "스트리머 미연결 — 화면에 보인 이름"].filter(Boolean).join(" · ");
  const who = <td className={`${tone} c-name`}>
    <span className={`overview-name${sub ? " is-sub" : ""}${p.streamer_slug ? "" : " is-unlinked"}`} title={flags || undefined}>
      {p.streamer_name && p.streamer_slug
        ? <Link href={profileHref("lol", p.streamer_slug)} target="_blank" className="hover:underline">{p.streamer_name}</Link>
        : p.observed_name ?? "이름 없음"}
    </span>
  </td>;
  const champ = <td className={`${tone} c-champ`}>
    <span className="overview-champ">
      {champion ? <img src={championIconPath(champion)} alt="" width={22} height={22} loading="lazy" /> : <span className="overview-champ-blank" />}
      <span>{champion?.name ?? p.champion_name ?? <Missing />}</span>
    </span>
  </td>;
  const kda = <td className={`${tone} c-kda`}>{kdaText(p)}</td>;
  return mirror ? <>{kda}{champ}{who}</> : <>{who}{champ}{kda}</>;
}
