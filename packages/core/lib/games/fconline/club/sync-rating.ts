import { db } from "../../../db/client.ts";
import type { FcoSiteClient } from "./site-client.ts";

/** Match the verified account before storing; request/parser failures preserve last good data. */
export async function syncRating(site: Pick<FcoSiteClient, "rating" | "seasonGrades">, ouid: string) {
  const sql = db();
  const [account] = await sql<{ nickname: string; nexon_sn: string }[]>`
    SELECT a.nickname, s.nexon_sn::text FROM fco_account a
    JOIN LATERAL (
      SELECT nickname, nexon_sn FROM fco_club_snapshot
      WHERE ouid = a.ouid AND status = 'ok' ORDER BY captured_at DESC, id DESC LIMIT 1
    ) s ON s.nickname = a.nickname WHERE a.ouid = ${ouid}`;
  if (!account) throw new Error("공식경기 점수: 신원이 확인된 최신 구단 스냅샷이 없다");
  const grades = await site.seasonGrades(account.nickname, Number(account.nexon_sn));
  const observation = await site.rating(account.nickname, Number(account.nexon_sn));
  await sql`INSERT INTO fco_rating (ouid, nickname, nexon_sn, score, source_at, current_grade, previous_best_grade, grades_checked_at)
    VALUES (${ouid}, ${account.nickname}, ${account.nexon_sn}, ${observation.score}, ${observation.sourceAt}, ${grades.current ? sql.json({ ...grades.current }) : null}, ${grades.previousBest ? sql.json({ ...grades.previousBest }) : null}, ${grades.checkedAt})
    ON CONFLICT (ouid) DO UPDATE SET nickname = EXCLUDED.nickname, nexon_sn = EXCLUDED.nexon_sn,
      score = EXCLUDED.score, source_at = EXCLUDED.source_at, checked_at = now(),
      current_grade = EXCLUDED.current_grade, previous_best_grade = EXCLUDED.previous_best_grade, grades_checked_at = EXCLUDED.grades_checked_at`;
  return observation;
}
