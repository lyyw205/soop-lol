/**
 * 결과창 판별기 학습 재료 모으기 — VOD 썸네일 시트 전체 + DB 의 초벌 정답.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/ck-local/detector/collect.mjs --from-db
 *   node --env-file-if-exists=apps/web/.env.local scripts/ck-local/detector/collect.mjs --vods 123,456
 *
 * 설계: docs/CK-LOCAL-DETECTOR.md
 * ★ 공식 대회 채널(lolbjmatch·afbjmatch)은 뺀다 — 멸망전 결과 화면은 방송 그래픽이라 CK 결과창과 다르다.
 * ★ 시트는 공용 시간축(vod-timeline.mjs)으로 받는다. 칸 i = 파일 로컬 i×3초, column 0 은 중복이라 뺀다.
 * ★ DB 에 쓰지 않는다. out/ck-detector/ 와 out/ck/<vod>/sheets/ 에만 쓴다.
 *
 * 산출:
 *   out/ck-detector/vods/<vod>.json  파일별 오프셋·칸 수·시트 경로·못 받은 범위
 *   out/ck-detector/seed-labels.jsonl  초벌 정답 {vod, at, label, source}
 *     label: result(클라이언트 결과창이라 Claude 가 표시한 시각) · notresult(Claude 가 읽고 결과 근거로 안 쓴 화면)
 *     ⚠ notresult 는 결과창 30초 안이면 넣지 않는다 — 같은 결과창의 다른 순간일 수 있다(실측 408장).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { db, closeDb } from "@soop-lol/core/lib/db/client";

import { vodDetail } from "../../lib/soop-vod.mjs";
import { fetchSheets, measureParts } from "../../lib/vod-timeline.mjs";

const OFFICIAL = ["lolbjmatch", "afbjmatch"];
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const OUT = "out/ck-detector";
mkdirSync(join(OUT, "vods"), { recursive: true });

let vods = (flag("--vods") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (args.includes("--from-db")) {
  const sql = db();
  const rows = await sql`
    select l.source_key, l.channel_id, f.kind, f.at_sec
    from match_evidence_frame f join event_lead l on l.id = f.lead_id
    where f.read_at is not null and f.at_sec is not null and l.source_key like 'vod:%'
      and l.channel_id <> all(${OFFICIAL})
      and l.id in (select lead_id from match_evidence_frame where kind = 'result' and read_at is not null)`;
  await closeDb();
  const byVod = new Map();
  for (const r of rows) {
    const v = r.source_key.slice(4);
    const x = byVod.get(v) ?? { channel: r.channel_id, result: [], other: [] };
    (r.kind === "result" ? x.result : x.other).push(r.at_sec);
    byVod.set(v, x);
  }
  const seed = [];
  for (const [vod, x] of byVod) {
    for (const at of x.result) seed.push({ vod: Number(vod), channel: x.channel, at, label: "result", source: "db:result" });
    for (const at of x.other) {
      if (x.result.some((t) => Math.abs(t - at) < 30)) continue;
      seed.push({ vod: Number(vod), channel: x.channel, at, label: "notresult", source: "db:other" });
    }
  }
  writeFileSync(join(OUT, "seed-labels.jsonl"), seed.map((s) => JSON.stringify(s)).join("\n") + "\n");
  console.log(`초벌 정답 ${seed.length}개 (result ${seed.filter((s) => s.label === "result").length}) · VOD ${byVod.size}개`);
  vods = [...new Set([...vods, ...byVod.keys()])];
}

let done = 0;
for (const vod of vods) {
  const path = join(OUT, "vods", `${vod}.json`);
  if (existsSync(path)) { done++; continue; }   // 재개 — 다 받은 VOD 는 건너뛴다
  const detail = await vodDetail(vod);
  if (!detail) { writeFileSync(path, JSON.stringify({ vod: Number(vod), missing: true })); console.log(`  ${vod} 없음(삭제·비공개)`); continue; }
  const { parts, total } = await measureParts(detail);
  const out = { vod: Number(vod), channel: detail.bj_id ?? detail.user_id ?? null, title: detail.title ?? null, total, parts: [] };
  for (const p of parts) {
    const cacheDir = join("out/ck", String(vod), "sheets", `f${p.index}`);
    if (!p.axisReliable) { out.parts.push({ index: p.index, offset: p.offset, length: p.length, cells: 0, reliable: false }); continue; }
    const got = await fetchSheets(p.file, p.length, { cacheDir });
    // 파이썬이 시트 파일을 직접 읽는다: sheets[k] = column k+1 (column 0 중복 제외)
    const sheets = got.sheets.map((s) => join(cacheDir, `c${s.column}.jpg`));
    out.parts.push({ index: p.index, offset: p.offset, length: p.length, cells: got.cells, sheets, failed: got.failed, reason: got.reason, reliable: true });
  }
  writeFileSync(path, JSON.stringify(out));
  done++;
  console.log(`  ${done}/${vods.length} ${vod} 칸 ${out.parts.reduce((s, p) => s + p.cells, 0)}`);
}
console.log(`VOD ${vods.length}개 준비 · out/ck-detector/vods/`);
