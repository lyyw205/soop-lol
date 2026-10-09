import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { writeFileSync } from "node:fs";
const sql = db();
const pairs = await sql`
  WITH p AS (
    SELECT mp.match_id, m.game_creation t, m.game_duration d, mp.champion_id, mp.outcome,
           lower(COALESCE(COALESCE(sa.streamer_id, mp.streamer_id)::text, mp.observed_name)) who
      FROM match_participant mp JOIN match m ON m.match_id=mp.match_id AND m.game_code='lol' AND m.source='manual'
      LEFT JOIN streamer_account sa ON sa.puuid=mp.puuid AND sa.active_to IS NULL
     WHERE mp.champion_id > 0 AND m.game_duration IS NOT NULL
  )
  SELECT a.match_id a, b.match_id b, count(*)::int same,
         count(*) FILTER (WHERE a.outcome=b.outcome)::int agree
    FROM p a JOIN p b ON a.champion_id=b.champion_id AND a.who=b.who AND a.match_id<b.match_id
         AND a.d=b.d AND abs(extract(epoch FROM (a.t-b.t))) <= 86400
   GROUP BY 1,2 HAVING count(*) >= 8`;
// union-find
const par = {}; const f = x => (par[x] ??= x, par[x] === x ? x : (par[x] = f(par[x])));
for (const r of pairs) par[f(r.a)] = f(r.b);
const groups = {};
for (const id of Object.keys(par)) (groups[f(id)] ??= []).push(id);
const out = [];
for (const ids of Object.values(groups)) {
  const ms = await sql`SELECT m.match_id, ev.name, ev.slug, ev.kind, m.series_id, m.winning_team w, m.game_duration d, m.origin, m.set_role,
     to_char(m.game_creation AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') t, m.game_creation_precision p,
     m.review_completed_at IS NOT NULL done, m.reviewed_at IS NOT NULL rv, m.visibility vis,
     (SELECT count(*) FROM match_pov mpv WHERE mpv.match_id=m.match_id)::int povs,
     (SELECT count(*) FROM match_participant x WHERE x.match_id=m.match_id AND (x.streamer_id IS NOT NULL OR x.puuid IS NOT NULL))::int linked,
     (SELECT count(*) FROM match_participant x WHERE x.match_id=m.match_id AND x.kills IS NOT NULL)::int kda
    FROM match m LEFT JOIN match_series ms ON ms.id=m.series_id LEFT JOIN event ev ON ev.id=COALESCE(ms.event_id,m.event_id)
   WHERE m.match_id = ANY(${ids}) ORDER BY m.match_id`;
  const agree = pairs.filter(r => ids.includes(r.a)).map(r => `${r.agree}/${r.same}`);
  out.push({ t: ms[0].t, ms, agree });
}
out.sort((a,b)=>a.t.localeCompare(b.t));
for (const g of out) {
  console.log(`■ ${g.t} 기록 ${g.ms.length}개 · 사람별 승패 일치 ${g.agree.join(' ')}`);
  for (const m of g.ms) console.log(`   ${m.match_id} [${m.name}/${m.kind}] ${m.series_id??'단판'} W${m.w} ${m.vis} 연결${m.linked} KDA${m.kda} pov${m.povs}${m.done?' 검수완료':''}${m.rv?' 관리자확인':''}`);
}
console.log('묶음', out.length, '중복 행', out.reduce((s,g)=>s+g.ms.length-1,0));
writeFileSync('/tmp/claude-1000/-home-lyyw2-repos-soop-lol/5bbe194b-f392-4d80-973f-36ea9a6b3ed6/scratchpad/dups.json', JSON.stringify(out,null,1));
await closeDb();
