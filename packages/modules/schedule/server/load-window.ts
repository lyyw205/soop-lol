"use server";

import { addDays, daysBetween, kstDayStart, listPublicSchedule, SCHEDULE_GAMES,
  type ScheduleGame } from "@soop-lol/core/lib/contract";

/** 공개 일정만 반환한다. 월간 달력의 최대 6주를 14일씩 나누어 조회한다. */
export async function loadScheduleWindow(query: { from: string; to: string; game: ScheduleGame | null; streamer: string | null }) {
  if (!query || !kstDayStart(query.from) || !kstDayStart(query.to)) throw new Error("날짜를 확인해 주세요.");
  const span = daysBetween(query.from, query.to);
  if (span < 0 || span >= 42) throw new Error("한 번에 최대 42일까지 불러올 수 있습니다.");
  if (query.game !== null && !SCHEDULE_GAMES.includes(query.game)) throw new Error("게임을 확인해 주세요.");
  if (query.streamer !== null && !/^[\w.-]+$/.test(query.streamer)) throw new Error("스트리머를 확인해 주세요.");
  const windows = Array.from({ length: Math.ceil((span + 1) / 14) }, (_, index) => {
    const from = addDays(query.from, index * 14);
    const end = addDays(from, 13);
    return listPublicSchedule({ ...query, from, to: end < query.to ? end : query.to });
  });
  const entries = (await Promise.all(windows)).flat();
  return [...new Map(entries.map((entry) => [entry.schedule_id, entry])).values()];
}
