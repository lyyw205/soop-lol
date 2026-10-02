import Link from "next/link";

import { listUpcomingScheduleFor } from "@soop-lol/core/lib/db/schedule-public";
import { ENTRY_STATE_LABEL, entryState, SCHEDULE_GAME_LABEL, slotTimeLabel } from "@soop-lol/core/lib/metrics/schedule";

import { roleHref } from "@/lib/module-links";

/**
 * 프로필 오른쪽 칸의 "다가오는 일정". 롤·FC 프로필이 같이 쓴다(사람 기준이라 게임을 가리지 않는다).
 *
 * ★ 편성표 모듈이 없으면 칸을 그리지 않는다 — core 는 모듈 이름을 모르고 역할('schedule')로 묻는다.
 * ★ 다가오는 일정이 없으면 빈 칸으로 둔다(본문 폭과 시선 축은 유지된다 — 원래 빈 자리였다).
 */
export async function UpcomingSchedule({ slug }: { slug: string }) {
  const empty = <aside className="record-sidebar record-sidebar-empty" aria-label="추가 스트리머 정보" />;
  const all = roleHref("schedule", {}, { s: slug });
  if (!all) return empty;
  const now = new Date();
  const rows = await listUpcomingScheduleFor(slug, now);
  if (rows.length === 0) return empty;
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const time = (s: { on_date: string; starts_at: Date | null; ends_at: Date | null }) =>
    ({ on_date: s.on_date, starts_at: s.starts_at ? new Date(s.starts_at) : null, ends_at: s.ends_at ? new Date(s.ends_at) : null });
  return (
    <aside className="record-sidebar" aria-label="다가오는 일정">
      <section className="arena-panel upcoming-schedule">
        <h2>다가오는 일정 <small className="record-sidebar-note">공지 기준</small></h2>
        <ul>
          {rows.map((e) => {
            const state = entryState(e.status);
            const href = roleHref("schedule", { id: e.schedule_id });
            const body = <>
              <span className="upcoming-when">{md(e.next.on_date)} · {slotTimeLabel(time(e.next))}</span>
              <strong>{e.title}</strong>
              <small>{SCHEDULE_GAME_LABEL[e.game_code]}{state !== "upcoming" && ` · ${ENTRY_STATE_LABEL[state]}`}{e.next.label && ` · ${e.next.label}`}</small>
            </>;
            return <li key={e.schedule_id}>{href ? <Link href={href}>{body}</Link> : body}</li>;
          })}
        </ul>
        <Link className="arena-panel-link" href={all}>편성표에서 보기　→</Link>
      </section>
    </aside>
  );
}
