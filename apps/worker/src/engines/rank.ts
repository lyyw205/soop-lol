/**
 * Engine A — 랭크 스냅샷. **가장 중요한 크론이다** (docs/PLAN.md §5).
 *
 * 과거 티어는 Riot API 에 없다. 오늘 안 쌓으면 그날은 영원히 구멍이고,
 * 나중에 어떤 방법으로도 메울 수 없다. 그래서 한 계정이 실패해도 나머지는 계속 간다.
 */

import {
  listIngestTargets,
  saveProfile,
  saveRankSnapshot,
  type IngestTarget,
} from "@soop-lol/core/lib/db/ingest";
import { kstDateString } from "@soop-lol/core/lib/time";

import { isFatal, type WorkerContext } from "../context.ts";
import { errorMessage, log } from "../log.ts";
import type { EngineResult } from "../job.ts";

const SCOPE = "engineA";

export async function runRankEngine(ctx: WorkerContext, now = new Date()): Promise<EngineResult> {
  const targets = await listIngestTargets();
  const snapshotDate = kstDateString(now);
  let ok = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const t of targets) {
    try {
      const entries = await ctx.riot.leagueEntriesByPuuid(t.puuid, t.summoner_id ?? undefined);
      await saveRankSnapshot(t.puuid, snapshotDate, entries);

      const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5");
      log.info(SCOPE, t.display_name, {
        acct: t.game_name ?? t.puuid.slice(0, 8),
        tier: solo?.tier ? `${solo.tier} ${solo.rank ?? ""} ${solo.leaguePoints}LP`.trim() : "UNRANKED",
      });

      await refreshProfileIfStale(ctx, t, now);
      ok++;
    } catch (e) {
      if (isFatal(e)) throw e;
      failed++;
      failures.push(`${t.display_name}/${t.game_name ?? t.puuid.slice(0, 8)}: ${errorMessage(e)}`);
      log.error(SCOPE, "랭크 조회 실패", { streamer: t.display_name, error: errorMessage(e) });
    }
  }

  return {
    processed: ok,
    detail: { date: snapshotDate, accounts: targets.length, failed, failures: failures.slice(0, 10) },
  };
}

/**
 * 닉네임·레벨 갱신. 랭크와 같은 크론에 얹는다 — 둘 다 하루 1회면 충분하고,
 * 별도 스케줄을 하나 더 만들면 그만큼 더 틀어질 곳이 생긴다.
 */
async function refreshProfileIfStale(ctx: WorkerContext, t: IngestTarget, now: Date): Promise<void> {
  const age = now.getTime() - (t.last_profile_synced_at?.getTime() ?? 0);
  if (age < ctx.cfg.profileMaxAgeMs) return;

  const [account, summoner] = await Promise.all([
    ctx.riot.accountByPuuid(t.puuid),
    ctx.riot.summonerByPuuid(t.puuid),
  ]);
  if (!account && !summoner) return;

  await saveProfile({
    puuid: t.puuid,
    game_name: account?.gameName ?? null,
    tag_line: account?.tagLine ?? null,
    // summonerId 는 폐기 예정이지만 league-v4 폴백이 살아 있는 동안은 필요하다.
    summoner_id: summoner?.id ?? null,
    summoner_level: summoner?.summonerLevel ?? null,
    profile_icon_id: summoner?.profileIconId ?? null,
    revision_date: summoner?.revisionDate ? new Date(summoner.revisionDate) : null,
  });
}
