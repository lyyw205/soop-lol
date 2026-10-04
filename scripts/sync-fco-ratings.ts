/** Refresh public accounts' official 1v1 ELO through the shared rate-limited gateway. */
import { db, closeDb } from "../packages/core/lib/db/client.ts";
import { FcoSiteClient } from "../packages/core/lib/games/fconline/club/site-client.ts";
import { syncRating } from "../packages/core/lib/games/fconline/club/sync-rating.ts";
try {
  const accounts = await db()<{ ouid: string; nickname: string }[]>`
    SELECT DISTINCT a.ouid, a.nickname FROM fco_account a
    JOIN streamer_fco_account l ON l.ouid = a.ouid AND l.visibility = 'public'
    JOIN streamer s ON s.id = l.streamer_id AND s.visibility = 'public' ORDER BY a.nickname`;
  const site = new FcoSiteClient();
  let errors = 0;
  for (const account of accounts) {
    try {
      const r = await syncRating(site, account.ouid);
      console.log(`${account.nickname}: ${r.score ?? '공식경기 검색 결과 없음'} (${r.sourceAt})`);
    } catch (e) { errors++; console.error(`${account.nickname}: ${e instanceof Error ? e.message : e}`); }
  }
  if (errors) process.exitCode = 1;
} finally { await closeDb(); }
