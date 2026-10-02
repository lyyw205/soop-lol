/**
 * 편성표 모듈 화면. host 가 로비 틀 안에서 /schedule 에 띄운다.
 *
 * ★ 상태는 관리자가 지정한 예정·진행중·취소·연기·완료를 표시한다.
 * ★ 초기 날짜와 필터는 URL이다. 이후 3일 확장과 날짜 이동은 공개 서버 함수로 추가 조회한다.
 * ★ 통합 간트에서 겹치는 일정은 레인을 나눈다. 좁은 화면은 가로 스크롤, 아래는 날짜별 목록.
 * ★ /schedule/[id] 는 일정 하나의 상세 — 근거 공지를 작성 시각순으로, 변경 이력과 함께.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { addDays, describeChange, entryPeriod, entryState, getPublicScheduleEntry, listPublicScheduleChanges, kstClock, kstDateString, kstDayStart, listPublicSchedule, SCHEDULE_GAMES, type ScheduleGame } from "@soop-lol/core/lib/contract";
import { WINDOW_DAYS, WINDOW_LEAD_DAYS } from "./layout.ts";
import { scheduleHref } from "./paths.ts";
import { Badges, EntryBody, md, weekday, resultLink } from "./content.tsx";
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
  if (params?.id) return <ScheduleDetail id={params.id} roleHref={roleHref} />;
  const now = new Date();
  const today = kstDateString(now);
  const dateParam = one(searchParams.date);
  const anchor = dateParam && kstDayStart(dateParam) ? dateParam : today;
  const from = addDays(anchor, -WINDOW_LEAD_DAYS);
  const to = addDays(from, WINDOW_DAYS - 1);
  const gameParam = one(searchParams.game);
  const game = SCHEDULE_GAMES.includes(gameParam as ScheduleGame) ? (gameParam as ScheduleGame) : null;
  const sParam = one(searchParams.s);
  const streamer = sParam && /^[\w.-]+$/.test(sParam) ? sParam : null;

  const entries = await listPublicSchedule({ from, to, game, streamer });
  return <ScheduleBoard key={`${from}:${game}:${streamer}`} initialEntries={entries} initialFrom={from}
    today={today} renderedAt={now.toISOString()} game={game} streamer={streamer}
    resultRoutes={{ tournaments: roleHref("tournaments", { slug: "schedule-result-slug" }), "fc-tournaments": roleHref("fc-tournaments", { slug: "schedule-result-slug" }) }} />;
}
/** /schedule/[id] — 일정 하나. 숨긴 일정·없는 id 는 404(공개 뷰가 거른다). */
async function ScheduleDetail({ id, roleHref }: { id: string; roleHref: Props["roleHref"] }) {
  const entry = await loadEntry(id);
  if (!entry) notFound();
  const changes = await listPublicScheduleChanges(id);
  const now = new Date();
  const state = entryState(entry.status);
  const period = entryPeriod(entry.slots);
  return (
    <div className="sched sched-detail">
      <p className="sched-back"><Link href={scheduleHref({ game: entry.game_code })}>← 편성표</Link></p>
      <div className="arena-title"><div>
        <h1>{entry.title}</h1>
        <p>{period && (period.from === period.to ? `${md(period.from)} (${weekday(period.from)})` : `${md(period.from)} ~ ${md(period.to)}`)}
          {" · "}상태는 공지 기준이고 실제 방송 여부는 확인하지 않습니다 · {md(kstDateString(now))} {kstClock(now)} 기준</p>
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
      </section>
    </div>
  );
}
