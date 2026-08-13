/**
 * **이미 기록된 경기인지 먼저 본다.** 같은 판을 두 번 파지 않기 위한 검사.
 *
 *   npm run ck:seen -- --channel phonics1 --range 2026-08-01:2026-08-31
 *   npm run ck:seen -- --channel phonics1 --range ... --mark    # 덮인 단서를 ignored 로
 *
 * ★ 왜 필요한가
 *   내전은 한 판을 평균 6명이 방송한다. 이상호를 조사하면서 김민교가 낀 판을
 *   이미 다 기록했는데, 다음에 김민교를 조사하면 **같은 판을 처음부터 다시 판다.**
 *   교차검증까지 또 돌리면 시간도 토큰도 두 배로 나간다.
 *
 *   그런데 그 판은 이미 **김민교가 참가자로 들어가 있다.** 그러면 새로 볼 게 없다.
 *
 * ★ 어떻게 보나
 *   그 채널 주인이 **참가자로 들어간 수기 경기**를 날짜별로 세고, 같은 날 단서와 맞춘다.
 *
 *     단서 VOD 가 그날 경기 N개를 잡았고
 *     그날 그 사람이 이미 M 판 기록돼 있으면
 *       M >= N  →  덮였다. 건너뛴다
 *       M <  N  →  일부만 덮였다. 안 덮인 만큼만 판독한다
 *
 * ⚠ **날짜 단위 근사다.** 경기 단위로 정확히 맞추려면 결과창을 읽어야 하는데,
 *   그걸 아끼려고 만든 검사라 그렇게 하면 뜻이 없다. 그래서 `--mark` 는
 *   **완전히 덮인 것만** 건드리고, 부분은 사람이 보라고 숫자만 보여 준다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";

import { makeOpt } from "./lib/cli.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const CHANNEL = opt("--channel", "");
const RANGE = opt("--range", "");
const MARK = argv.includes("--mark");

if (!CHANNEL || !RANGE || !RANGE.includes(":")) {
  console.error("쓰는 법:  npm run ck:seen -- --channel <채널> --range <시작>:<끝> [--mark]");
  process.exit(1);
}
const [FROM, TO] = RANGE.split(":");

const sql = db();
try {
  const [who] = await sql<{ id: string; display_name: string }[]>`
    SELECT s.id, s.display_name FROM streamer s
      JOIN streamer_channel c ON c.streamer_id = s.id
     WHERE c.platform = 'soop' AND c.channel_id = ${CHANNEL} AND c.active_to IS NULL`;
  if (!who) { console.error(`채널 '${CHANNEL}' 의 스트리머가 등록돼 있지 않다.`); process.exit(1); }

  // 그 사람이 이미 참가자로 들어간 수기 경기 (날짜별)
  const seen = await sql<{ d: string; n: number; events: string[] }[]>`
    SELECT (m.game_creation AT TIME ZONE 'Asia/Seoul')::date::text AS d,
           count(*)::int AS n,
           array_agg(DISTINCT e.name) AS events
      FROM match_participant mp
      JOIN match m ON m.match_id = mp.match_id
      LEFT JOIN event e ON e.id = m.event_id
     WHERE mp.streamer_id = ${who.id} AND m.source = 'manual'
       AND (m.game_creation AT TIME ZONE 'Asia/Seoul')::date BETWEEN ${FROM}::date AND ${TO}::date
     GROUP BY 1`;
  const seenBy = new Map(seen.map((s) => [s.d, s]));

  // 그 채널의 단서 (아직 판독 안 한 것)
  const leads = await sql<{ source_key: string; title: string; d: string; games: number; state: string }[]>`
    SELECT source_key, title, state,
           (observed_at AT TIME ZONE 'Asia/Seoul')::date::text AS d,
           coalesce((raw->>'games')::int, 0) AS games
      FROM event_lead
     WHERE source = 'vod_title' AND channel_id = ${CHANNEL}
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN ${FROM}::date AND ${TO}::date
     ORDER BY observed_at`;

  console.log(`${who.display_name} (${CHANNEL}) · ${FROM} ~ ${TO}`);
  console.log(`이미 기록된 수기 경기 ${seen.reduce((a, s) => a + s.n, 0)}판 · 단서 ${leads.length}건\n`);

  let covered = 0, partial = 0, fresh = 0;
  const toMark: string[] = [];
  for (const l of leads) {
    if (l.state !== "new") continue;
    const s = seenBy.get(l.d);
    const m = s?.n ?? 0;
    if (m > 0 && m >= l.games) {
      covered++; toMark.push(l.source_key);
      console.log(`  ✓ 덮임   ${l.d} 경기${l.games} ≤ 기록${m}  ${l.title.slice(0, 34)}`);
      console.log(`           → ${(s?.events ?? []).filter(Boolean).join(", ")}`);
    } else if (m > 0) {
      partial++;
      console.log(`  ~ 일부   ${l.d} 경기${l.games} > 기록${m}  ${l.title.slice(0, 34)}`);
      console.log(`           → 안 덮인 ${l.games - m}판만 판독하면 된다`);
    } else {
      fresh++;
      console.log(`  · 새것   ${l.d} 경기${l.games}          ${l.title.slice(0, 34)}`);
    }
  }

  console.log(`\n덮임 ${covered} · 일부 ${partial} · 새것 ${fresh}`);
  if (covered > 0 && !MARK) {
    console.log(`\n덮인 ${covered}건을 건너뛰려면:  npm run ck:seen -- --channel ${CHANNEL} --range ${RANGE} --mark`);
  }
  if (MARK && toMark.length > 0) {
    const r = await sql`
      UPDATE event_lead SET state = 'ignored',
             note = '다른 스트리머 조사에서 이미 기록된 경기 — 같은 판을 두 번 파지 않는다 (ck:seen)',
             updated_at = now()
       WHERE source = 'vod_title' AND source_key = ANY(${toMark}) AND state = 'new'
      RETURNING source_key`;
    console.log(`\n${r.length}건을 ignored 로 표시했다. 교차검증·프레임 추출을 건너뛴다.`);
  }
} finally {
  await closeDb();
}
