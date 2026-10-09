/**
 * **사진으로 같은 판이라고 확인한 두 경기를 합친다** — 남길 쪽으로 근거·시점·최종 근거·VOD 후보 연결을 옮기고 숨길 쪽을 공개에서 뺀다.
 *
 *   npm run ck:dedupe -- --keep <남길 경기> --drop <숨길 경기> --evidence "두 결과창 대조: …"            # 미리보기
 *   npm run ck:dedupe -- --keep … --drop … --evidence "…" --apply                                      # 기록
 *   npm run ck:dedupe -- --different <경기1> <경기2> [--apply]                     # 다른 판으로 확인 — 목록에 다시 안 뜬다
 *
 * 후보는 `npm run ck:record -- --todo` 의 "같은 판으로 보이는 공개 경기" 에 나온다. 후보는 답이 아니다 —
 * 두 경기의 결과창을 열어 같은 판인지 본 뒤에 쓴다. 다른 판이면 합치지 말고 distinct_from 을 남긴다.
 * 정리 규칙은 packages/core/lib/db/ck-duplicates.ts 의 mergeDuplicateMatch 하나다.
 */
import { closeDb } from "@soop-lol/core/lib/db/client";
import { markDistinctMatches, mergeDuplicateMatch } from "@soop-lol/core/lib/db/ck-duplicates";

import { makeOpt } from "./lib/cli.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const keep = opt("--keep", ""), drop = opt("--drop", ""), evidence = opt("--evidence", "");
const apply = argv.includes("--apply");
const different = argv.indexOf("--different");
if (different >= 0) {
  const [a, b] = argv.slice(different + 1, different + 3);
  try {
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) throw new Error("쓰기:  npm run ck:dedupe -- --different <경기1> <경기2> [--apply]");
    const r = await markDistinctMatches(a, b, { apply });
    console.log(`${a}  ≠  ${b}${r.already ? "  — 이미 다른 판으로 기록돼 있다" : apply ? "  — 다른 판으로 기록했다" : "   [미리보기 — --apply 로 기록]"}`);
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
  process.exit();
}
if (!keep || !drop || !evidence.trim()) {
  console.error('쓰기:  npm run ck:dedupe -- --keep <남길 경기> --drop <숨길 경기> --evidence "두 결과창 대조: …" [--apply]');
  process.exit(1);
}
try {
  const p = await mergeDuplicateMatch({ keep, drop, evidence }, { apply });
  console.log(`${p.drop}  →  ${p.keep}${apply ? "" : "   [미리보기 — --apply 로 기록]"}`);
  if (p.already) console.log("  이미 정리된 쌍이다 — 옮길 것이 없고 숨김도 끝났다.");
  console.log(`  근거 프레임 ${p.frames_moved}장 · 시점 기록 ${p.povs_moved.length}개 · VOD 후보 연결 ${p.candidates_relinked}개 이전`
    + `${p.final_evidence_moved ? " · 최종 근거 이전" : ""}${p.hidden ? " · 숨김" : ""}`);
  if (p.povs_kept_on_drop.length) console.log(`  같은 방송의 시점 기록이 양쪽에 있어 숨긴 쪽에 남김: ${p.povs_kept_on_drop.length}개`);
  if (p.final_evidence_kept_on_drop) console.log("  숨긴 쪽 최종 근거 문장은 숨긴 쪽에 남는다(남길 쪽 것이 기준).");
  if (p.drop_grouping.series_id || p.drop_grouping.event_id) {
    console.log(`  숨긴 쪽에만 있던 묶음(옮기지 않음): 시리즈 ${p.drop_grouping.series_id ?? "-"} · 대회 ${p.drop_grouping.event_id ?? "-"}`);
  }
  if (p.value_differences.length) {
    console.log(`  ⚠ 남길 쪽 값과 다른 자리 ${p.value_differences.length} — 값은 고치지 않았다. 화면으로 어느 쪽이 맞는지 확인할 것:`);
    for (const d of p.value_differences) console.log(`     ${d}`);
  }
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
