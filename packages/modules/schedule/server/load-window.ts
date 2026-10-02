"use server";

import { daysBetween, kstDayStart, listPublicSchedule, SCHEDULE_GAMES,
  type ScheduleGame } from "@soop-lol/core/lib/contract";

/** 공개 일정만 반환한다. 확장은 3일, 날짜 이동은 11일씩 요청한다. */
export async function loadScheduleWindow(query: { from: string; to: string; game: ScheduleGame | null; streamer: string | null }) {
  if (!query || !kstDayStart(query.from) || !kstDayStart(query.to)) throw new Error("날짜를 확인해 주세요.");
  const span = daysBetween(query.from, query.to);
  if (span < 0 || span >= 14) throw new Error("한 번에 최대 14일까지 불러올 수 있습니다.");
  if (query.game !== null && !SCHEDULE_GAMES.includes(query.game)) throw new Error("게임을 확인해 주세요.");
  if (query.streamer !== null && !/^[\w.-]+$/.test(query.streamer)) throw new Error("스트리머를 확인해 주세요.");
  return listPublicSchedule(query);
}
