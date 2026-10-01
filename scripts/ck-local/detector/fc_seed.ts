/**
 * FC 라벨 시드 — DB 의 FC 맥락 근거 사진(fco_context_evidence) 중 장면이 분명한 것을 라벨로 옮긴다.
 *   node --env-file-if-exists=apps/web/.env.local scripts/ck-local/detector/fc_seed.ts
 * role result → fc_result · start·end → fc_match. pre·post·역할 없음은 화면이 섞여 안 쓴다(docs/CK-LOCAL-FC-PLAN.md §4-2).
 * out/ck-detector/review-labels.jsonl 에 source "db:fco-evidence" 로 붙인다(이미 있으면 다시 안 붙인다).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { db, closeDb } from "@soop-lol/core/lib/db/client";

const OUT = "out/ck-detector/review-labels.jsonl";
const have = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.source === "db:fco-evidence").map((r) => `${r.vod}:${r.at}`) : []);
const sql = db();
const rows = await sql`select vod_title_no v, role, at_sec from fco_context_evidence
  where kind = 'vod_frame' and at_sec is not null and role in ('result', 'start', 'end')`;
let n = 0;
for (const r of rows) {
  if (have.has(`${r.v}:${r.at_sec}`)) continue;
  appendFileSync(OUT, `${JSON.stringify({ vod: Number(r.v), at: r.at_sec, label: r.role === "result" ? "fc_result" : "fc_match", source: "db:fco-evidence" })}\n`);
  n++;
}
console.log(`FC 시드 ${n}칸 추가 (DB 근거 ${rows.length})`);
await closeDb();
