/**
 * 편성표 모듈 화면. 들어온 게임의 메뉴 안에서 공개 일정을 월간·일별로 보여준다.
 *
 * ★ 상태는 관리자가 지정한 예정·진행중·취소·연기·완료를 표시한다.
 * ★ 날짜·필터는 URL이다. 월 이동과 게임·스트리머 변경은 공개 서버 함수로 조회한다.
 * ★ 대회 기간과 공지된 경기일을 구분한다. 상태를 시각으로 추정하지 않는다.
 * ★ /schedule/[id] 는 일정 하나의 상세 — 근거 공지를 작성 시각순으로, 변경 이력과 함께.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { describeChange, entryPeriod, entryState, getPublicScheduleEntry, listPublicScheduleChanges, kstClock, kstDateString, kstDayStart, listPublicStreamerOptions, SCHEDULE_GAMES, submitScheduleHref, type ScheduleGame } from "@soop-lol/core/lib/contract";
import { agendaRange, parseKind } from "./agenda.ts";
import { scheduleHref, scheduleQuery } from "./paths.ts";
import { Badges, EntryBody, md, weekday, resultLink } from "./content.tsx";
import { loadScheduleWindow } from "../server/load-window.ts";
import { ScheduleBoard } from "./schedule-board.tsx";
import "./schedule.css";

type Props = {
  params?: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
  roleHref: (role: string, params?: Record<string, string>) => string | null;
};

// 제목과 본문이 같은 요청에서 두 번 읽지 않게 한다.
const loadEntry = cache(getPublicScheduleEntry);

export async function generateMetadata({ params }: Props) {
  if (!params?.id) return { title: "편성표" };
  return { title: (await loadEntry(params.id))?.title ?? "편성표" };
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
export default async function SchedulePage({ params, searchParams, roleHref }: Props) {
  const context = scheduleQuery(searchParams);
  if (params?.id) return <ScheduleDetail id={params.id} roleHref={roleHref} backHref={scheduleHref(context)} site={context.site} />;
  const now = new Date();
  const today = kstDateString(now);
  const dateParam = one(searchParams.date);
  const anchor = dateParam && kstDayStart(dateParam) ? dateParam : today;
  const { from, to } = agendaRange(anchor);
  const gameParam = one(searchParams.game);
  const game = SCHEDULE_GAMES.includes(gameParam as ScheduleGame) ? (gameParam as ScheduleGame) : null;
  const sParam = one(searchParams.s);
  const streamer = sParam && /^[\w.-]+$/.test(sParam) ? sParam : null;

  const entries = await loadScheduleWindow({ from, to, game, streamer });
  const people = (await listPublicStreamerOptions()).map(({ slug, display_name, channel_id }) => ({ slug, display_name, channel_id }));
  const kind = parseKind(one(searchParams.kind));
  const query = (one(searchParams.q) ?? "").slice(0, 100);
  return <ScheduleBoard key={`${context.site}:${anchor}:${game}:${streamer}:${kind}:${query}`} initialEntries={entries} initialDate={anchor} site={context.site}
    initialKind={kind} initialSearch={query} people={people}
    today={today} renderedAt={now.toISOString()} game={game} streamer={streamer}
    resultRoutes={{ tournaments: roleHref("tournaments", { slug: "schedule-result-slug" }), "fc-tournaments": roleHref("fc-tournaments", { slug: "schedule-result-slug" }) }} />;
}
/** /schedule/[id] — 일정 하나. 숨긴 일정·없는 id 는 404(공개 뷰가 거른다). */
async function ScheduleDetail({ id, roleHref, backHref, site }: { id: string; roleHref: Props["roleHref"]; backHref: string; site: string }) {
  const entry = await loadEntry(id);
  if (!entry) notFound();
  const changes = await listPublicScheduleChanges(id);
  const state = entryState(entry.status);
  const period = entryPeriod(entry.slots);
  return (
    <div className="sched sched-detail" data-theme={site === "lol" ? "lol" : "fconline"}>
      <p className="sched-back"><Link href={backHref}>← 편성표</Link></p>
      <div className="arena-title"><div>
        <h1>{entry.title}</h1>
        <p>{period && (period.from === period.to ? `${md(period.from)} (${weekday(period.from)})` : `${md(period.from)} ~ ${md(period.to)}`)}
          {" · "}공지 기준 · 한국 시간</p>
      </div></div>
      <section className="sched-entry sched-detail-card" data-state={state}>
        <div className="sched-detail-head"><Badges entry={entry} state={state} /></div>
        <div className="sched-body"><EntryBody entry={entry} result={resultLink(entry, roleHref)} sourcesByTime /></div>
      </section>
      <section className="sched-list" aria-label="변경 이력">
        <h2>변경 이력</h2>
        {changes.length === 0 ? <p className="sched-muted">공지 뒤 바뀐 것이 없습니다.</p> : <ol className="sched-changes">
          {changes.map((c, i) => <li key={i}><small className="tabular">{md(kstDateString(new Date(c.changed_at)))} {kstClock(new Date(c.changed_at))}</small> {describeChange(c)}</li>)}
        </ol>}
        <p className="sched-muted">틀렸거나 바뀐 내용이 있나요? <Link href={submitScheduleHref(entry.schedule_id)} prefetch={false}>제보하기 →</Link></p>
      </section>
    </div>
  );
}
