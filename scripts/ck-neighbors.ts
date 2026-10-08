/**
 * 결과창 앞뒤 원본을 검수 화면에 올린다 — 사람 검수용. Claude 세션이 끝난 뒤 셸이 부른다(토큰 0).
 *
 *   npm run ck:neighbors -- --vod <번호> [--offsets -9,-6,-3,3,6,9] [--dry-run]
 *
 * ★ 왜: 검수 화면 사진은 조사 세션이 판독하려고 뽑은 원본뿐이라 한 판에 몇 장이다. 결과창이 메모장에
 *   가렸거나 넘어가는 순간이면 사람이 다른 장면을 볼 수 없었다(2026-10-08 다누리 9시 CK 1경기).
 *   썸네일은 화질이 낮아 판독에 쓸 수 없다 — 그래서 경기에 연결된 결과창 사진마다 앞뒤 원본을 받는다.
 * ★ 조사 세션은 이 사진을 보지 않는다 — "안 읽은" 미연결 사진(kind other)으로만 올린다. 경기 연결은 하지 않는다.
 * ★ 같은 시각 사진이 이미 있으면 건너뛰어 여러 번 돌려도 같다(기록도 (lead, 경로) 단위로 갱신).
 * 종료 코드: 0 완료(올릴 것 없음 포함) · 1 사용법 · 2 단서 없음
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { recordEvidenceFrames } from "@soop-lol/core/lib/db/ck";

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1] ?? null; };
const VOD = Number(flag("--vod"));
const OFFSETS = (flag("--offsets") ?? "-9,-6,-3,3,6,9").split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0);
const DRY = argv.includes("--dry-run");
if (!Number.isInteger(VOD) || VOD <= 0 || !OFFSETS.length) {
  console.error("사용법: npm run ck:neighbors -- --vod <번호> [--offsets -9,-6,-3,3,6,9] [--dry-run]");
  process.exit(1);
}

const sql = db();
let code = 0;
try {
  const [lead] = await sql<{ id: string }[]>`SELECT id FROM event_lead WHERE source = 'vod_title' AND source_key = ${`vod:${VOD}`}`;
  if (!lead) { console.error(`vod:${VOD}: 단서가 없다`); code = 2; }
  else {
    const frames = await sql<{ at_sec: number | null; match_id: string | null; kind: string }[]>`
      SELECT at_sec, match_id, kind FROM match_evidence_frame WHERE lead_id = ${lead.id}::uuid`;
    const have = new Set(frames.map((f) => f.at_sec).filter((t): t is number => t != null).map(Math.round));
    const results = frames.filter((f) => f.match_id != null && f.kind === "result" && f.at_sec != null).map((f) => Math.round(f.at_sec!));
    const want = [...new Set(results.flatMap((t) => OFFSETS.map((o) => t + o)))]
      .filter((t) => t >= 0 && !have.has(t)).sort((a, b) => a - b);
    console.log(`vod:${VOD}: 연결된 결과창 ${new Set(results).size}장 → 앞뒤 원본 ${want.length}장${DRY ? " (미리보기)" : ""}`);
    if (want.length && !DRY) {
      try {
        execFileSync("node", ["scripts/ck-probe.mjs", "--vod", String(VOD), "--at", want.join(",")], { stdio: ["ignore", "ignore", "inherit"] });
      } catch { console.log("  ⚠ 원본 일부를 못 받았다 — 받은 것만 올린다"); }
      const got = want.map((t) => ({ t, path: `out/ck/${VOD}/g${String(t).padStart(7, "0")}.jpg` })).filter((g) => existsSync(g.path));
      await recordEvidenceFrames(lead.id, got.map((g) => ({ frame_path: g.path, at_sec: g.t, kind: "other" as const, read: false })));
      console.log(`  올림 ${got.length}/${want.length}`);
    }
  }
} finally {
  await closeDb();
}
process.exit(code);
