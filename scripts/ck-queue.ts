/**
 * 자동 조사 큐 — 와치리스트 채널의 최근 N일 VOD 중 **아직 조사를 끝내지 않은 것**.
 *
 *   npm run ck:queue                     # 최근 3일, 표만 본다
 *   npm run ck:queue -- --days 5
 *   npm run ck:queue -- --write out/ck/auto/queue.json
 *
 * `scripts/ck-auto.sh` 가 이 큐를 ck-research 스킬에 넘긴다. DB 에는 아무것도 쓰지 않는다.
 *
 * ★ 카테고리로 거르지 않는다
 *   VOD 카테고리는 방송 전체에 붙는 한 값이다. "토크"로 켜고 중간에 내전을 하는 방송이
 *   있으니, 롤 카테고리만 받으면 그런 판이 조용히 빠진다. 무엇을 했는지는 프레임이 말한다.
 *
 * ★ 무엇을 "조사함" 으로 치나 — `scan.status = done` 이고 **못 본 구간이 없을 때만**
 *   - 단서만 있는 lead(ck:collect 가 쌓은 것, status 없음) → 큐에 넣는다
 *   - `running` → 중간에 끊긴 실행이다. 넣는다. 안 넣으면 영영 반쯤 본 채로 남는다
 *   - `done` + `failed` 남음 → 넣는다. 스킬 정의상 그 VOD 의 결론은 완결이 아니다
 *   미해결 후보는 기준이 아니다 — 그건 VOD 를 다시 훑을 일이 아니라 `ck:record --todo` 몫이다.
 *
 * ★ `running` 은 기간 밖이어도 넣는다 — 와치리스트 채널 것만
 *   조사가 긴 VOD 는 한 회차에 못 끝나 `running` 으로 남는다. 최근 N일로만 거르면 N일이 지나는 순간
 *   반쯤 본 채로 영영 빠진다. 그래서 기간과 무관하게 합친다.
 *   `failed_left`(done + 못 본 구간)는 기간 안에서만 넣는다. 영상 길이 밖 지점·영구 누락 세그먼트처럼
 *   다시 봐도 안 풀리는 실패가 섞여 있어서, 기간 밖까지 넣으면 6시간마다 영원히 재시도한다.
 *
 * ★ 조회가 잘리면 시끄럽게 말하고 종료 코드 2 를 낸다. 조용히 적게 가져오면 누락이 티가 안 난다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { kstDate, makeOpt } from "./lib/cli.mjs";
import { listBroadcasts } from "./lib/soop-vod.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const DAYS = Number(opt("--days", "3"));
const WRITE = opt("--write", "");
// 오늘 포함 DAYS 일. regDate(=방송 종료) 기준이라, 자정을 넘긴 방송도 종료일로 잡힌다.
const FROM = kstDate(DAYS - 1);
const TO = kstDate(0);

interface Item {
  title_no: number; channel_id: string; streamer: string; slug: string;
  title: string; ended_at: string; hours: number; category: string | null;
  reason: "new" | "lead_only" | "running" | "failed_left";
}

const sql = db();
let truncated: string[] = [];
try {
  const watch = await sql<{ display_name: string; slug: string; channel_id: string | null }[]>`
    SELECT s.display_name, s.slug, c.channel_id
      FROM streamer s
      LEFT JOIN streamer_channel c ON c.streamer_id = s.id AND c.platform = 'soop' AND c.active_to IS NULL
     WHERE s.watch
     ORDER BY s.display_name`;
  const noChannel = watch.filter((w) => !w.channel_id);
  if (noChannel.length) console.log(`⚠ 채널이 없어 못 훑는 ${noChannel.length}명: ${noChannel.map((w) => w.display_name).join(", ")}`);

  const found: Omit<Item, "reason">[] = [];
  for (const w of watch.filter((x) => x.channel_id)) {
    const list = await listBroadcasts(w.channel_id!, { from: FROM, to: TO });
    if ((list as typeof list & { truncated?: boolean }).truncated) truncated.push(w.display_name);
    for (const v of list) {
      found.push({
        title_no: v.title_no, channel_id: v.channel_id, streamer: w.display_name, slug: w.slug,
        title: v.title, ended_at: v.ended_at, hours: Math.round(v.hours * 10) / 10, category: v.category,
      });
    }
  }

  const keys = found.map((v) => `vod:${v.title_no}`);
  const leads = keys.length === 0 ? [] : await sql<{ source_key: string; status: string | null; failed: number }[]>`
    SELECT source_key, raw->'scan'->>'status' AS status,
           CASE WHEN jsonb_typeof(raw->'scan'->'failed') = 'array'
                THEN jsonb_array_length(raw->'scan'->'failed') ELSE 0 END::int AS failed
      FROM event_lead WHERE source_key = ANY(${keys})`;
  const byKey = new Map(leads.map((l) => [l.source_key, l]));

  const queue: Item[] = [];
  let skipped = 0;
  for (const v of found) {
    const l = byKey.get(`vod:${v.title_no}`);
    let reason: Item["reason"] | null;
    if (!l) reason = "new";
    else if (l.status === "done") reason = l.failed > 0 ? "failed_left" : null;
    else if (l.status === "running") reason = "running";
    else reason = "lead_only";
    if (reason) queue.push({ ...v, reason });
    else skipped++;
  }
  // 기간 밖의 running — 와치리스트 채널 것만. 수동 조사 중인 남의 VOD 를 자동 실행이 가로채지 않게 한다.
  const inQueue = new Set(queue.map((q) => `vod:${q.title_no}`));
  const channels = watch.filter((w) => w.channel_id).map((w) => w.channel_id!);
  const stale = channels.length === 0 ? [] : await sql<{ source_key: string; channel_id: string; title: string; observed_at: Date }[]>`
    SELECT source_key, channel_id, title, observed_at FROM event_lead
     WHERE source_key LIKE 'vod:%' AND raw->'scan'->>'status' = 'running'
       AND channel_id = ANY(${channels})`;
  for (const l of stale) {
    if (inQueue.has(l.source_key)) continue;
    const w = watch.find((x) => x.channel_id === l.channel_id)!;
    queue.push({
      title_no: Number(l.source_key.slice(4)), channel_id: l.channel_id, streamer: w.display_name, slug: w.slug,
      title: l.title, ended_at: l.observed_at.toISOString(), hours: 0, category: null, reason: "running",
    });
  }
  // 오래된 것부터 — 기간 창에서 먼저 빠져나가는 쪽이다.
  queue.sort((a, b) => a.ended_at.localeCompare(b.ended_at));

  console.log(`와치리스트 ${watch.length}명 · ${FROM} ~ ${TO} · VOD ${found.length}개 · 조사 끝 ${skipped} · 큐 ${queue.length}`);
  for (const q of queue) {
    console.log(`  ${q.ended_at}  vod:${q.title_no}  ${q.hours}h  ${q.streamer}  [${q.reason}]  ${q.title}`);
  }
  if (truncated.length) console.log(`\n⚠ VOD 목록이 잘렸다 — 큐가 불완전하다: ${truncated.join(", ")}`);

  if (WRITE) {
    mkdirSync(dirname(WRITE), { recursive: true });
    writeFileSync(WRITE, JSON.stringify({ from: FROM, to: TO, generated_at: new Date().toISOString(), truncated, queue }, null, 2));
    console.log(`\n${WRITE} 에 적었다.`);
  }
} finally {
  await closeDb();
}
if (truncated.length) process.exit(2);
