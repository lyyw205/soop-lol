import { db } from "../../../db/client.ts";
import type { FcoSiteClient } from "./site-client.ts";

/** An independent observation; a failed lookup never overwrites the last good one. */
export async function syncTeamColors(site: Pick<FcoSiteClient, "profileTeamColors">, ouid: string) {
  const sql = db();
  const [account] = await sql<{ nickname: string; nexon_sn: string }[]>`
    SELECT a.nickname, s.nexon_sn::text FROM fco_account a
    JOIN LATERAL (
      SELECT nickname, nexon_sn FROM fco_club_snapshot
      WHERE ouid = a.ouid AND status = 'ok' ORDER BY captured_at DESC, id DESC LIMIT 1
    ) s ON s.nickname = a.nickname WHERE a.ouid = ${ouid}`;
  if (!account) throw new Error("팀컬러: 신원이 확인된 최신 구단 스냅샷이 없다");
  const observation = await site.profileTeamColors(account.nickname, Number(account.nexon_sn));
  await sql`INSERT INTO fco_team_colors (ouid, nickname, nexon_sn, source_at, colors, source, source_slot)
    VALUES (${ouid}, ${account.nickname}, ${account.nexon_sn}, ${observation.sourceAt}, ${sql.json(observation.colors.map(c => ({ ...c })))}, ${observation.source}, ${observation.slot})
    ON CONFLICT (ouid) DO UPDATE SET nickname = EXCLUDED.nickname, nexon_sn = EXCLUDED.nexon_sn,
      checked_at = now(), source_at = EXCLUDED.source_at, colors = EXCLUDED.colors, source = EXCLUDED.source, source_slot = EXCLUDED.source_slot`;
  return observation;
}
