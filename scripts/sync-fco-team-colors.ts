/** Refresh public linked accounts only; the gateway enforces one request/second. */
import { db, closeDb } from "../packages/core/lib/db/client.ts";
import { FcoSiteClient } from "../packages/core/lib/games/fconline/club/site-client.ts";
import { syncTeamColors } from "../packages/core/lib/games/fconline/club/sync-team-colors.ts";
try {
  const accounts = await db()<{ ouid: string; nickname: string }[]>`
    SELECT DISTINCT a.ouid, a.nickname FROM fco_account a
    JOIN streamer_fco_account l ON l.ouid = a.ouid AND l.visibility = 'public'
    JOIN streamer s ON s.id = l.streamer_id AND s.visibility = 'public' ORDER BY a.nickname`;
  const site = new FcoSiteClient();
  let errors = 0;
  for (const account of accounts) {
    try {
      const r = await syncTeamColors(site, account.ouid);
      console.log(`${account.nickname}: ${r.colors.map(c => c.name).join(' / ') || '프로필 소속 팀컬러 없음'}`);
    } catch (e) { errors++; console.error(`${account.nickname}: ${e instanceof Error ? e.message : e}`); }
  }
  if (errors) process.exitCode = 1;
} finally { await closeDb(); }
