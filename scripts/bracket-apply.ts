/**
 * 대진 시드 파일(seed/brackets/<대회>.json)을 DB 에 반영한다. docs/TOURNAMENT-FORMAT-PLAN.md
 *
 *   npm run bracket:apply -- seed/brackets/2026-mini-ppuchamps.json           # 계산 결과만 본다(되돌린다)
 *   npm run bracket:apply -- seed/brackets/2026-mini-ppuchamps.json --apply   # 실제로 쓴다
 *
 * 같은 파일을 다시 돌려도 안전하다. 구조 오류가 있으면 아무것도 쓰지 않는다.
 */
import { readFileSync } from "node:fs";
import { applyBracketSpec } from "../packages/core/lib/db/event-bracket.ts";
import { closeDb } from "../packages/core/lib/db/client.ts";
import { displayRank, rankText } from "../packages/core/lib/tournament/bracket.ts";
import type { BracketSpec } from "../packages/core/lib/tournament/spec.ts";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const write = process.argv.includes("--apply");
if (!file) {
  console.error("사용법: npm run bracket:apply -- seed/brackets/<대회>.json [--apply]");
  process.exit(1);
}
const spec = JSON.parse(readFileSync(file, "utf8")) as BracketSpec;
try {
  const report = await applyBracketSpec(spec, { dryRun: !write });
  const name = (id: string) => report.names[id] ?? id;
  console.log(`${write ? "반영" : "미리보기(되돌림)"} — ${spec.game}/${spec.event}`);
  console.log(`  참가 ${report.entrants} · 칸 ${report.slots} · 화살표 ${report.routes} · 경기 연결 ${report.links} · 결정 추가 ${report.decisionsAdded}`);
  if (report.decisionsKeptByAdmin.length) console.log(`  사람이 내린 결정이 있어 덮지 않은 칸: ${report.decisionsKeptByAdmin.join(", ")}`);
  console.log("\n칸");
  for (const s of report.result.slots) {
    const state = s.source === "inferred" ? "추론" : s.source === "decision" ? `결정(${s.basis})` : s.state === "decided" ? "경기" : s.state;
    console.log(`  ${String(s.slot.no).padStart(2)} ${(s.slot.label ?? s.slot.lane ?? "").padEnd(8)} ${state.padEnd(14)} 승자 ${s.winners.length ? s.winners.map(name).join(",") : "—"}`);
  }
  console.log("\n순위");
  for (const p of report.result.placements) {
    const r = displayRank(p);
    console.log(`  ${(r ? rankText(r.min, r.max) : "—").padEnd(6)} ${name(p.entrant)}  ${r?.from ?? ""} · ${p.certainty}`);
  }
  if (report.result.issues.length) {
    console.log("\n문제");
    for (const i of report.result.issues) console.log(`  [${i.level}] ${i.message}`);
  }
} finally {
  await closeDb();
}
