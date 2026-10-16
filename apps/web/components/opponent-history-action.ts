"use server";
import { getStreamerBySlug } from "@soop-lol/core/lib/db/public";
import { listOpponentHistoryMatches } from "@soop-lol/core/lib/db/opponent-history";
import { isMatchCategoryFilter } from "@soop-lol/core/lib/metrics/category";
import { resolveRecordPeriod } from "@soop-lol/core/lib/metrics/record-period";

export async function loadOpponentHistory(slug: string, otherId: string, category: string, from?: string, to?: string, laneOnly = false) {
  if (!/^[0-9a-f-]{36}$/i.test(otherId) || !isMatchCategoryFilter(category)) throw new Error("잘못된 조건입니다");
  const person = await getStreamerBySlug(slug);
  const period = resolveRecordPeriod({from, to});
  if (!person || period.error) throw new Error("기록을 찾을 수 없습니다");
  return listOpponentHistoryMatches(person.streamer_id, otherId, {category, from: period.from, to: period.to, laneOnly});
}
