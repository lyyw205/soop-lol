/**
 * FC 결과 화면 라벨 재료 모으기 — 넥슨 API 경기의 **종료 시각**으로 각 방송 VOD 에서 결과 화면이 뜰 자리를 좁힌다.
 *   node --env-file-if-exists=apps/web/.env.local scripts/fco-local/harvest.ts [--per-channel 2] [--from 2026-08-23 --to 2026-09-29]
 *
 * ★ ck-local 과 분리된 FC 전용 도구다(docs/FCO-SCREEN-MATCH-DESIGN.md §4.1 4단계, A안). ck-local 의 판별기·말뭉치
 *   (out/ck-detector/)는 읽지도 쓰지도 않는다. 썸네일 캐시(out/ck/<vod>/sheets)만 공용이다.
 * 출력: out/fco-detector/vods/<vod>.json(시트 목록, collect.mjs 와 같은 모양) · out/fco-detector/harvest.json(경기 종료 초)
 * DB 에 쓰지 않는다.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, closeDb } from "@soop-lol/core/lib/db/client";
import { listBroadcasts, vodDetail } from "../lib/soop-vod.mjs";
import { fetchSheets, measureParts } from "../lib/vod-timeline.mjs";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PER = Number(opt("--per-channel", "2"));
const FROM = opt("--from", "2026-08-23"), TO = opt("--to", "2026-09-29");
const OUT = "out/fco-detector";
mkdirSync(join(OUT, "vods"), { recursive: true });

const sql = db();
const people = await sql<{ id: string; slug: string; ch: string | null }[]>`
  SELECT s.id, s.slug, (SELECT c.channel_id FROM streamer_channel c WHERE c.streamer_id = s.id AND c.platform = 'soop'
                         ORDER BY c.is_primary DESC LIMIT 1) AS ch
    FROM streamer s WHERE EXISTS (SELECT 1 FROM streamer_fco_account l WHERE l.streamer_id = s.id AND l.visibility = 'public')`;
const harvest: { vod: number; channel: string; slug: string; ends: { sec: number; provider_match_id: string }[] }[] = [];
for (const p of people) {
  if (!p.ch) continue;
  const games = await sql<{ provider_match_id: string; played_at: Date }[]>`
    SELECT d.provider_match_id, m.game_creation AS played_at FROM fco_match_participant mp
      JOIN match m ON m.match_id = mp.match_id JOIN fco_match_detail d ON d.match_id = m.match_id
     WHERE mp.streamer_id = ${p.id} AND m.source = 'provider_api'`;
  const list = (await listBroadcasts(p.ch, { from: FROM, to: TO })).filter((v: { hours: number }) => v.hours >= 1);
  // 목록의 종료 시각·길이로 대강 센다(상세 호출을 아끼려고). 경기가 많은 VOD 부터.
  const scored = list.map((v: { title_no: number; ended_at: string; hours: number }) => {
    const end = Date.parse(`${v.ended_at.replace(" ", "T")}+09:00`), start = end - v.hours * 3600_000;
    return { v, n: games.filter((g) => +g.played_at >= start && +g.played_at <= end).length };
  }).filter((x: { n: number }) => x.n >= 2).sort((a: { n: number }, b: { n: number }) => b.n - a.n).slice(0, PER);
  for (const { v } of scored) {
    const detail = await vodDetail(v.title_no);
    if (!detail?.broad_start) continue;
    const startMs = Date.parse(`${String(detail.broad_start).replace(" ", "T")}+09:00`);
    const { parts, total } = await measureParts(detail);
    const ends = games.map((g) => ({ sec: Math.round((+g.played_at - startMs) / 1000), provider_match_id: g.provider_match_id }))
      .filter((e) => e.sec > 0 && e.sec < total).sort((a, b) => a.sec - b.sec);
    if (ends.length < 2) continue;
    const path = join(OUT, "vods", `${v.title_no}.json`);
    if (!existsSync(path)) {
      const out = { vod: v.title_no, channel: p.ch, title: (detail.title ?? null) as string | null, total, parts: [] as unknown[] };
      for (const part of parts as { index: number; offset: number; length: number; axisReliable: boolean; file: unknown }[]) {
        const cacheDir = join("out/ck", String(v.title_no), "sheets", `f${part.index}`);
        if (!part.axisReliable) { out.parts.push({ index: part.index, offset: part.offset, length: part.length, cells: 0, reliable: false }); continue; }
        const got = await fetchSheets(part.file, part.length, { cacheDir } as never);
        out.parts.push({ index: part.index, offset: part.offset, length: part.length, cells: got.cells,
          sheets: got.sheets.map((s: { column: number }) => join(cacheDir, `c${s.column}.jpg`)), failed: got.failed, reason: got.reason, reliable: true });
      }
      writeFileSync(path, JSON.stringify(out));
    }
    harvest.push({ vod: v.title_no, channel: p.ch, slug: p.slug, ends });
    console.log(`  ${p.slug} vod ${v.title_no} 경기 ${ends.length}`);
  }
}
writeFileSync(join(OUT, "harvest.json"), JSON.stringify(harvest, null, 1));
console.log(`VOD ${harvest.length}개 · 경기 종료 ${harvest.reduce((s, h) => s + h.ends.length, 0)}개 → ${OUT}/harvest.json`);
await closeDb();
