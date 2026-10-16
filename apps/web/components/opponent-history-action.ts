"use server";
import { getStreamerBySlug } from "@soop-lol/core/lib/db/public";
import { listOpponentHistoryMatches } from "@soop-lol/core/lib/db/opponent-history";
import { isFormat } from "@soop-lol/core/lib/metrics/format";
import { isMapTab } from "@soop-lol/core/lib/metrics/record-scope";
import { resolveRecordPeriod } from "@soop-lol/core/lib/metrics/record-period";

export async function loadOpponentHistory(slug: string, otherId: string, map: string, format: string, from?: string, to?: string, laneOnly = false) {
  if (!/^[0-9a-f-]{36}$/i.test(otherId) || !isMapTab(map) || !(format === "all" || isFormat(format))) throw new Error("잘못된 조건입니다");
  const person = await getStreamerBySlug(slug);
  const period = resolveRecordPeriod({from, to});
  if (!person || period.error) throw new Error("기록을 찾을 수 없습니다");
  return listOpponentHistoryMatches(person.streamer_id, otherId, {map, format, from: period.from, to: period.to, laneOnly});
}
