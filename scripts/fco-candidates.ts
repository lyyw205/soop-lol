/**
 * FC 계정 그물 — 등록된 스트리머들과 반복해서 붙은 미등록 감독명을 뽑는다.
 *
 *   npm run fco:candidates                 # 후보 순위 (친선 대전 기준)
 *   npm run fco:candidates -- --all-modes  # 공식경기(랜덤 매칭)까지 센다
 *   npm run fco:candidates -- --ouid <ouid> # 한 후보의 대전 기록 — 조사할 VOD 시각
 *   npm run fco:candidates -- --ouid <ouid> --channel <SOOP채널>
 *        # 그 채널 VOD 에서 경기마다 몇 초인가 + 뽑을 명령. 본인 시점에 감독명이 뜨는지 본다
 *
 * ★ 친선(모드 40)을 기준으로 세는 이유: 공식경기(50)·공식친선(60)은 랜덤 매칭이라 상대가
 *   누구든 붙는다. 친선은 서로 초대해야 붙는다 — 아는 사이라는 신호다.
 * ★ 후보는 후보일 뿐이다. 감독명만으로 스트리머에 연결하지 않는다 — 방송 화면(본인 시점에
 *   그 감독명이 뜨는 장면)이나 본인이 밝힌 것으로 확인한 뒤 fco:sync --source-url 로 등록한다.
 * 조사 결과는 seed/fco-account-sweep.json 에 쌓는다 — 같은 후보를 두 번 조사하지 않게.
 */
import { readFile } from "node:fs/promises";
import { db, closeDb } from "@soop-lol/core/lib/db/client";
import { fcoProbePlan, fcoVodOffsets } from "@soop-lol/core/lib/games/fconline/timeline";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const flag = (name: string) => args.includes(`--${name}`);
const SWEEP = "seed/fco-account-sweep.json";

interface SweepEntry { ouid: string; nickname: string; verdict: "linked" | "not_streamer" | "unknown"; streamer?: string; note: string; checked_at: string }

const kst = (d: Date | string) => new Date(new Date(d).getTime() + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

async function main() {
  const sql = db();
  const sweep: SweepEntry[] = JSON.parse(await readFile(SWEEP, "utf8").catch(() => "[]"));
  const checked = new Map(sweep.map((e) => [e.ouid, e]));
  const ouid = option("ouid");

  if (ouid) {
    const rows = await sql<{ played_at: Date; mode_key: string | null; me: string; me_goals: number | null; them: string; them_goals: number | null; slug: string; channel_id: string | null; provider_match_id: string }[]>`
      SELECT m.game_creation AS played_at, m.mode_key, p.nickname AS me, p.goals AS me_goals,
             o.nickname AS them, o.goals AS them_goals, s.slug, sc.channel_id, d.provider_match_id
        FROM fco_match_participant p
        JOIN fco_match_participant o ON o.match_id = p.match_id AND o.ouid <> p.ouid AND o.streamer_id IS NOT NULL
        JOIN streamer s ON s.id = o.streamer_id
        LEFT JOIN streamer_channel sc ON sc.streamer_id = s.id AND sc.platform = 'soop' AND sc.active_to IS NULL
        JOIN match m ON m.match_id = p.match_id
        JOIN fco_match_detail d ON d.match_id = p.match_id
       WHERE p.ouid = ${ouid}
       ORDER BY m.game_creation DESC`;
    if (!rows.length) throw new Error(`등록된 스트리머와의 대전이 없다: ${ouid}`);
    console.log(`${rows[0].me} (${ouid}) — 등록 스트리머와 ${rows.length}경기`);
    if (checked.has(ouid)) console.log(`  이미 조사함: ${checked.get(ouid)!.verdict} — ${checked.get(ouid)!.note}`);
    const channel = option("channel");
    // 채널을 주면 그 채널 VOD 에서 경기 위치를 찾는다 — 방송 시작은 broad_start 그대로(추정하지 않는다).
    const spans: { vod: number; startMs: number; lengthSec: number }[] = [];
    if (channel) {
      const { listBroadcasts, vodDetail } = await import("./lib/soop-vod.mjs");
      const days = rows.map((r) => new Date(new Date(r.played_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10)).sort();
      const vods = await listBroadcasts(channel, { from: days[0], to: days.at(-1) });
      if ((vods as typeof vods & { truncated?: boolean }).truncated) console.log("  ⚠ VOD 목록 조회가 잘렸다 — 아래는 불완전하다");
      for (const v of vods) {
        const d = await vodDetail(v.title_no);
        if (!d?.broad_start) continue;
        const ms = Number(d.total_file_duration ?? 0)
          || (d.files ?? []).reduce((sum: number, f: { duration?: number }) => sum + Number(f.duration ?? 0), 0);
        spans.push({ vod: v.title_no, startMs: Date.parse(`${String(d.broad_start).replace(" ", "T")}+09:00`), lengthSec: Math.round(ms / 1000) });
      }
      console.log(`  채널 ${channel}: 기간 안 VOD ${spans.length}개`);
    }
    for (const r of rows) {
      console.log(`  ${kst(r.played_at)} 모드${r.mode_key ?? "?"}  ${r.me} ${r.me_goals ?? "?"} : ${r.them_goals ?? "?"} ${r.them}(${r.slug}${r.channel_id ? ` · ${r.channel_id}` : " · 채널 없음"})  ${r.provider_match_id}`);
      if (!channel) continue;
      const m = { provider_match_id: r.provider_match_id, played_at: new Date(r.played_at).toISOString() };
      const hits = spans.map((sp) => ({ sp, o: fcoVodOffsets(m, sp) })).filter((h) => h.o);
      if (!hits.length) { console.log("      이 채널 VOD 에 없음"); continue; }
      for (const { sp, o } of hits) {
        const plan = fcoProbePlan(o!, sp.lengthSec);
        console.log(`      VOD ${sp.vod} 종료 ${o!.end}s → npm run ck:probe -- --vod ${sp.vod} --between ${plan.result[0]}:${plan.result[1]} --divide 5`);
      }
    }
    return;
  }

  const modeFilter = flag("all-modes") ? null : "40";
  const rows = await sql<{ ouid: string; nickname: string; streamers: number; games: number; friendly: number; last: Date; faced: string }[]>`
    SELECT p.ouid,
           (array_agg(p.nickname ORDER BY m.game_creation DESC))[1] AS nickname,
           count(DISTINCT o.streamer_id)::int AS streamers,
           count(*)::int AS games,
           count(*) FILTER (WHERE m.mode_key = '40')::int AS friendly,
           max(m.game_creation) AS last,
           string_agg(DISTINCT s.display_name, ', ') AS faced
      FROM fco_match_participant p
      JOIN fco_match_participant o ON o.match_id = p.match_id AND o.ouid <> p.ouid AND o.streamer_id IS NOT NULL
      JOIN streamer s ON s.id = o.streamer_id
      JOIN match m ON m.match_id = p.match_id
     WHERE p.streamer_id IS NULL
       AND (${modeFilter}::text IS NULL OR m.mode_key = ${modeFilter})
       AND NOT EXISTS (SELECT 1 FROM streamer_fco_account l WHERE l.ouid = p.ouid)
     GROUP BY p.ouid
    HAVING count(DISTINCT o.streamer_id) >= 2 OR count(*) >= 5
     ORDER BY streamers DESC, games DESC`;
  const open = rows.filter((r) => !checked.has(r.ouid));
  console.log(`후보 ${open.length}명 (${modeFilter ? "친선 모드 40 기준" : "전 모드"}) — 스트리머 2명 이상 또는 5경기 이상\n`);
  for (const r of open.slice(0, Number(option("top") ?? 40))) {
    console.log(`${String(r.streamers).padStart(2)}명 ${String(r.games).padStart(3)}경기  ${r.nickname.padEnd(14)} 마지막 ${kst(r.last)}  vs ${r.faced}  ${r.ouid}`);
  }
  const done = rows.filter((r) => checked.has(r.ouid));
  if (done.length) console.log(`\n이미 조사한 후보 ${done.length}명은 뺐다 (${SWEEP})`);
}

try { await main(); } finally { await closeDb(); }
