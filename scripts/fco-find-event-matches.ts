/** 수집된 경기에서 대회 시간대 후보를 좁힌다. 출력은 후보이며 대회 연결은 별도 확인한다. */
import { closeDb, db } from "@soop-lol/core/lib/db/client";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  const from = option("from");
  const to = option("to");
  const streamer = option("streamer");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("사용법: npm run fco:find-event-matches -- --from YYYY-MM-DD --to YYYY-MM-DD [--streamer slug]");
  }
  const rows = await db()<{
    provider_match_id: string; game_creation: string; mode_key: string | null;
    event_name: string | null; players: string;
  }[]>`
    SELECT d.provider_match_id, m.game_creation, m.mode_key, e.name AS event_name,
           string_agg(p.nickname || ' ' || coalesce(p.goals::text, '?') || '골', ' : ' ORDER BY p.side_no) AS players
      FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      JOIN fco_match_participant p ON p.match_id = m.match_id
      LEFT JOIN event e ON e.id = m.event_id
     WHERE m.game_code = 'fconline'
       AND m.game_creation >= (${from}::date::timestamp AT TIME ZONE 'Asia/Seoul')
       AND m.game_creation < ((${to}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Seoul')
       AND (${streamer ?? null}::text IS NULL OR EXISTS (
         SELECT 1 FROM fco_match_participant mine
         JOIN streamer s ON s.id = mine.streamer_id
         WHERE mine.match_id = m.match_id AND s.slug = ${streamer ?? null}
       ))
     GROUP BY d.provider_match_id, m.match_id, e.name
     ORDER BY m.game_creation, d.provider_match_id
  `;
  if (!rows.length) console.log("해당 기간에 수집된 FC 온라인 경기가 없습니다.");
  for (const row of rows) {
    console.log(`${row.game_creation} | ${row.players} | 모드 ${row.mode_key} | ${row.provider_match_id}${row.event_name ? ` | 연결됨: ${row.event_name}` : ""}`);
  }
  console.log(`후보 ${rows.length}건. 대회 경기 여부는 방송·공지 등 근거로 확인한 뒤 fco:link-event를 사용하세요.`);
}

try { await main(); } finally { await closeDb(); }
