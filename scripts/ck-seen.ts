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
 * ★ "있다" 와 "다 찼다" 는 다르다
 *   경기 행이 있어도 **챔피언·KDA 가 비어 있으면 덮인 게 아니다.** 실제로 멸망전
 *   36경기는 승패·로스터만 있고 참가행 344개 전부 champion_id=0, KDA=0 이었다.
 *   그걸 "덮임" 으로 걸러 버리면 채울 기회를 영영 잃는다.
 *   → **내용이 있는 판만** 덮인 것으로 센다.
 *
 * ── 두 가지로 맞춘다 ────────────────────────────────────────────────
 * 1. **VOD 번호** (정확) — 단서의 `url` 에 있는 번호가 이미 적재된 경기의
 *    `source_url` 에 있으면 **그 방송은 이미 판독했다.** 날짜와 무관하다.
 * 2. **날짜** (근사) — 그 사람이 그날 이미 기록된 판이 단서의 경기 수 이상이면 덮였다고 본다.
 *
 * ⚠ **날짜만으로는 틀린다 — 실제로 틀렸다(2026-08-19).**
 *   · 06-26 02:34 '학살CK' 를 같은 날 21:50 시작한 '깐부CK' 로 덮였다고 했다.
 *     **다른 판이다.** 그대로 건너뛰었으면 3판을 통째로 잃었다.
 *   · 06-14 단서는 이미 적재된 **06-13 호진CK 와 같은 VOD** 인데 날짜가 달라
 *     '새것' 으로 나왔다. VOD 번호로 봤으면 즉시 잡혔다.
 *
 * → 그래서 `--mark` 는 **VOD 번호가 맞은 것만** 건드린다. 날짜만 맞은 건
 *   `? 날짜만` 으로 보여 주고 사람이 판단한다.
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

  // ── 이미 판독한 VOD 번호 ─────────────────────────────────────────
  // 채널을 가리지 않고 본다 — 남의 방송에서 결과창을 회수한 판도 그 VOD 는 이미 판독한 것이다.
  const loadedVods = new Map<string, Set<string>>();   // VOD 번호 → 대회 slug 들
  for (const r of await sql<{ url: string; slug: string | null }[]>`
    SELECT DISTINCT m.source_url AS url, e.slug
      FROM match m
      LEFT JOIN match_series ms ON ms.id=m.series_id AND ms.game_code=m.game_code
      LEFT JOIN event e ON e.id=COALESCE(ms.event_id,m.event_id)
     WHERE m.source = 'manual' AND m.source_url IS NOT NULL`) {
    const id = /(\d{6,})/u.exec(r.url ?? "")?.[1];
    if (!id) continue;
    if (!loadedVods.has(id)) loadedVods.set(id, new Set());
    if (r.slug) loadedVods.get(id)!.add(r.slug);
  }

  // 그 사람이 이미 참가자로 들어간 수기 경기 (날짜별)
  const seen = await sql<{ d: string; n: number; thin: number; events: string[] }[]>`
    SELECT (m.game_creation AT TIME ZONE 'Asia/Seoul')::date::text AS d,
           -- ★ 내용이 찬 판만 '덮였다' 로 센다. 승패만 있는 행은 채울 거리가 남아 있다.
           -- ⚠ coalesce 가 필수다. 0020 이 KDA 를 nullable 로 풀어서, 못 읽은 행은
           --    셋을 더한 값이 NULL 이 된다. 그러면 두 FILTER 가
           --    (TRUE AND NULL) = NULL 로 **둘 다 빗나가** n 에도 thin 에도 안 세고,
           --    이 스크립트의 존재 이유인 "채울 거리" 를 조용히 적게 보고한다.
           count(*) FILTER (WHERE mp.champion_id > 0
                              OR coalesce(mp.kills, 0) + coalesce(mp.deaths, 0)
                                 + coalesce(mp.assists, 0) > 0)::int AS n,
           count(*) FILTER (WHERE mp.champion_id = 0
                             AND coalesce(mp.kills, 0) + coalesce(mp.deaths, 0)
                                 + coalesce(mp.assists, 0) = 0)::int AS thin,
           array_agg(DISTINCT e.name) AS events
      FROM match_participant mp
      JOIN match m ON m.match_id = mp.match_id
      LEFT JOIN match_series ms ON ms.id=m.series_id AND ms.game_code=m.game_code
      LEFT JOIN event e ON e.id=COALESCE(ms.event_id,m.event_id)
     WHERE mp.streamer_id = ${who.id} AND m.source = 'manual'
       AND (m.game_creation AT TIME ZONE 'Asia/Seoul')::date BETWEEN ${FROM}::date AND ${TO}::date
     GROUP BY 1`;
  const seenBy = new Map(seen.map((s) => [s.d, s]));

  // 그 채널의 단서 (아직 판독 안 한 것)
  const leads = await sql<{ source_key: string; title: string; d: string; games: number; state: string; url: string | null }[]>`
    SELECT source_key, title, state, url,
           (observed_at AT TIME ZONE 'Asia/Seoul')::date::text AS d,
           coalesce((raw->>'games')::int, 0) AS games
      FROM event_lead
     WHERE source = 'vod_title' AND channel_id = ${CHANNEL}
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN ${FROM}::date AND ${TO}::date
     ORDER BY observed_at`;

  console.log(`${who.display_name} (${CHANNEL}) · ${FROM} ~ ${TO}`);
  const thin = seen.reduce((a, s) => a + s.thin, 0);
  console.log(`내용까지 찬 경기 ${seen.reduce((a, s) => a + s.n, 0)}판`
    + (thin > 0 ? ` · **승패만 있는 판 ${thin}개(채울 거리)**` : "")
    + ` · 단서 ${leads.length}건\n`);

  let covered = 0, partial = 0, fresh = 0;
  const toMark: string[] = [];
  for (const l of leads) {
    if (l.state !== "new") continue;
    const s = seenBy.get(l.d);
    const m = s?.n ?? 0;
    const vod = /(\d{6,})/u.exec(l.url ?? "")?.[1];
    const byVod = vod ? loadedVods.get(vod) : undefined;

    // ★ VOD 번호가 맞으면 날짜와 무관하게 확정이다. 이것만 --mark 대상이다.
    if (byVod) {
      covered++; toMark.push(l.source_key);
      console.log(`  ✓ 판독함 ${l.d} VOD ${vod}  ${l.title.slice(0, 34)}`);
      console.log(`           → ${[...byVod].join(", ")}`);
    } else if (m > 0 && m >= l.games) {
      // 날짜만 맞았다. 같은 날 **다른** 내전일 수 있다 — 자동으로 건너뛰지 않는다.
      partial++;
      console.log(`  ? 날짜만 ${l.d} 경기${l.games} ≤ 기록${m}  ${l.title.slice(0, 34)}`);
      console.log(`           → ${(s?.events ?? []).filter(Boolean).join(", ")}`);
      console.log(`           ⚠ VOD 번호는 안 맞는다. 같은 날 다른 판일 수 있으니 사람이 본다.`);
    } else if (m > 0 || (s?.thin ?? 0) > 0) {
      partial++;
      if ((s?.thin ?? 0) > 0) console.log(`  ~ 채움   ${l.d} 승패만 있는 판 ${s!.thin}개 — 챔피언·KDA 를 채울 수 있다`);
      console.log(`  ~ 일부   ${l.d} 경기${l.games} > 기록${m}  ${l.title.slice(0, 34)}`);
      console.log(`           → 안 덮인 ${l.games - m}판만 판독하면 된다`);
    } else {
      fresh++;
      console.log(`  · 새것   ${l.d} 경기${l.games}          ${l.title.slice(0, 34)}`);
    }
  }

  console.log(`\n판독함 ${covered} · 확인필요 ${partial} · 새것 ${fresh}`);
  if (covered > 0 && !MARK) {
    console.log(`\nVOD 번호가 맞은 ${covered}건을 건너뛰려면:  npm run ck:seen -- --channel ${CHANNEL} --range ${RANGE} --mark`);
  }
  if (MARK && toMark.length > 0) {
    const r = await sql`
      UPDATE event_lead SET state = 'ignored',
             note = '이미 판독한 VOD 다 (source_url 번호 일치) — 같은 방송을 두 번 파지 않는다 (ck:seen)',
             updated_at = now()
       WHERE source = 'vod_title' AND source_key = ANY(${toMark}) AND state = 'new'
      RETURNING source_key`;
    console.log(`\n${r.length}건을 ignored 로 표시했다. 교차검증·프레임 추출을 건너뛴다.`);
  }
} finally {
  await closeDb();
}
