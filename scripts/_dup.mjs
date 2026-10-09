import { closeDb, db } from "@soop-lol/core/lib/db/client";
const sql = db();
const rows = await sql`
  WITH p AS (
    SELECT mp.match_id, m.game_creation t, m.game_creation_precision prec, mp.champion_id,
           lower(COALESCE(COALESCE(sa.streamer_id, mp.streamer_id)::text, mp.observed_name)) who
      FROM match_participant mp JOIN match m ON m.match_id=mp.match_id AND m.game_code='lol' AND m.source<>'public_queue'
      LEFT JOIN streamer_account sa ON sa.puuid=mp.puuid AND sa.active_to IS NULL
     WHERE mp.champion_id > 0
  )
  SELECT a.match_id a, b.match_id b, count(*)::int same, min(a.prec) pa, min(b.prec) pb,
         round(abs(extract(epoch FROM (min(a.t)-min(b.t))))/60)::int dmin
    FROM p a JOIN p b ON a.champion_id=b.champion_id AND a.match_id<b.match_id
         AND abs(extract(epoch FROM (a.t-b.t))) <= 86400*2
   GROUP BY 1,2 HAVING count(*) >= 8 ORDER BY 1`;
const info = async (id) => (await sql`SELECT m.match_id, m.winning_team w, m.game_duration d, ev.name, m.series_id,
   to_char(m.game_creation AT TIME ZONE 'Asia/Seoul','MM-DD HH24:MI') t, m.game_creation_precision p, m.review_completed_at IS NOT NULL done, m.visibility vis, m.reviewed_at IS NOT NULL rv,
   (SELECT count(*) FROM match_participant WHERE match_id=m.match_id)::int n
   FROM match m LEFT JOIN match_series ms ON ms.id=m.series_id LEFT JOIN event ev ON ev.id=COALESCE(ms.event_id,m.event_id) WHERE m.match_id=${id}`)[0];
for (const r of rows) {
  const A = await info(r.a), B = await info(r.b);
  console.log(`챔피언까지 같은 사람 ${r.same}명 Δ${r.dmin}분(${A.p}/${B.p})\n  A ${A.t} ${A.match_id} [${A.name}] W${A.w} ${A.d}s ${A.vis}${A.done?' 검수완료':''}${A.rv?' 관리자확인':''}\n  B ${B.t} ${B.match_id} [${B.name}] W${B.w} ${B.d}s ${B.vis}${B.done?' 검수완료':''}${B.rv?' 관리자확인':''}`);
}
console.log('pairs', rows.length);
await closeDb();
