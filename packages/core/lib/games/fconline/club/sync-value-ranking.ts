import { db } from "../../../db/client.ts";
import type { FcoSiteClient } from "./site-client.ts";

export async function syncValueRanking(site: Pick<FcoSiteClient, "valueRanking">) {
  const ranking = await site.valueRanking();
  await db()`INSERT INTO fco_value_ranking (day, entries)
    VALUES (${ranking.day}, ${db().json(ranking.entries.map(e => ({ ...e })))})
    ON CONFLICT (day) DO UPDATE SET entries = EXCLUDED.entries, checked_at = now()`;
  return ranking;
}
