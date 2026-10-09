import { readFileSync } from "node:fs";
import { listWatched } from "@soop-lol/core/lib/db/watchlist";
import { titleExclusion, vodWork } from "@soop-lol/core/lib/metrics/ck-vod-status";
import { listBroadcasts } from "./lib/soop-vod.mjs";
import { vodRaws } from "@soop-lol/core/lib/db/ck-backfill";
import { closeDb } from "@soop-lol/core/lib/db/client";
const H = JSON.parse(readFileSync("/tmp/claude-1000/haiku-done.json", "utf8"));
const hd = new Set<number>(H.done), ht = new Set<number>(H.touched);
const FROM = process.argv[2] ?? "2026-09-20", TO = "2026-10-09";
const watch = (await listWatched("lol")).filter((w) => w.channel_id);
let T = { all: 0, done: 0, excl: 0, open: 0, haiku: 0 };
for (const w of watch) {
  const list = await listBroadcasts(w.channel_id!, { from: FROM, to: TO });
  const raws = await vodRaws(list.map((v: any) => v.title_no));
  const open: string[] = []; let done = 0, excl = 0, haiku = 0;
  for (const v of list as any[]) {
    if (titleExclusion(v.title)) { excl++; continue; }
    const r = vodWork(raws.get(v.title_no), v.hours > 0 ? Math.round(v.hours * 3600) : null).reason;
    if (!r) { done++; if (hd.has(v.title_no)) haiku++; }
    else open.push(`${v.ended_at.slice(5, 10)}:${r}${ht.has(v.title_no) ? "(H)" : ""}`);
  }
  T.all += list.length; T.done += done; T.excl += excl; T.open += open.length; T.haiku += haiku;
  console.log(`${w.display_name.padEnd(8)} VOD ${String(list.length).padStart(3)} · 끝 ${String(done).padStart(3)}(Haiku ${haiku}) · 제외 ${excl} · 남음 ${open.length}  ${open.sort().join(" ")}`);
}
console.log("합계", JSON.stringify(T));
await closeDb();
