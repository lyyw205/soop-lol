/**
 * 이미 저장된 미확인 자리 중 **화면 이름이 한 사람으로 확정되는 것**을 그 사람에게 붙인다.
 *
 *   npm run ck:link-known                 # 미리보기 — 이름별로 누구에게 몇 자리 붙일지
 *   npm run ck:link-known -- --apply      # 기록
 *
 * ★ 확정 규칙은 저장 단계와 같다(core/lib/db/known-names.ts) — 이미 붙은 자리·주인 있는 계정 이름으로 한 사람일 때만.
 *   새로 저장되는 경기는 ck:merge 가 같은 규칙으로 붙이고, 이 명령은 그 전에 쌓인 자리를 메운다(2026-10-12).
 * ★ 붙이는 길은 자동 식별(linkParticipantsInTx) — 검수 보호(칸 단위)를 지키고, 바뀐 칸은 actor=auto 로 남기며 조우를 다시 만든다.
 * ★ 검수 완료는 지킨다 — 붙이는 근거가 이미 확인된 연결이라 다시 검수할 일이 아니다. 트리거(0043)가 푼 완료를 같은
 *   트랜잭션에서 되돌린다(ck:name 의 confirmedByUser 와 같은 방식). 일괄 수정이 완료를 풀었던 사고(2026-10 repair:puuid)를 막는다.
 * ★ 같은 경기에 그 사람이 이미 있으면 그 자리는 건너뛴다(같은 사람 두 번 금지). 비공개 경기는 목록에 없다.
 */
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { linkParticipantsInTx, listUnidentifiedParticipants } from "@soop-lol/core/lib/db/ck";
import { knownNameOwnersInTx, normName } from "@soop-lol/core/lib/db/known-names";

const APPLY = process.argv.includes("--apply");
const sql = db();
try {
  const names = await listUnidentifiedParticipants(100000, 0);
  const known = await knownNameOwnersInTx(sql, names.map((n) => n.observed_name));
  const label = new Map((await sql<{ id: string; display_name: string }[]>`
    SELECT id::text, display_name FROM streamer WHERE id = ANY(${[...new Set(known.values())]}::uuid[])`).map((r) => [r.id, r.display_name]));
  // 경기 → [{자리, 사람}] — 경기 단위로 한 번에 붙인다.
  const byMatch = new Map<string, { participant_id: number; streamer_id: string; name: string }[]>();
  let seats = 0;
  const summary: string[] = [];
  for (const n of names) {
    const sid = known.get(normName(n.observed_name));
    if (!sid) continue;
    summary.push(`${n.observed_name} → ${label.get(sid)} ${n.targets.length}자리`);
    for (const t of n.targets) {
      byMatch.set(t.match_id, [...(byMatch.get(t.match_id) ?? []), { participant_id: t.participant_id, streamer_id: sid, name: n.observed_name }]);
      seats++;
    }
  }
  console.log(`미확인 이름 ${names.length}개 중 확정 ${summary.length}개 · ${seats}자리 · 경기 ${byMatch.size}개${APPLY ? "" : "   [미리보기 — --apply 로 기록]"}`);
  for (const s of summary.sort()) console.log("  " + s);
  if (APPLY && byMatch.size) {
    let linked = 0, skipped = 0, kept = 0, locked = 0;
    for (const [matchId, links] of [...byMatch].sort()) {
      await sql.begin(async (tx) => {
        const [m] = await tx<{ review_completed_at: Date | null; review_version: number }[]>`
          SELECT review_completed_at, review_version FROM match WHERE match_id = ${matchId} FOR UPDATE`;
        const present = new Set((await tx<{ sid: string }[]>`
          SELECT streamer_id::text AS sid FROM match_participant WHERE match_id = ${matchId} AND streamer_id IS NOT NULL`).map((r) => r.sid));
        const go = links.filter((l) => { if (present.has(l.streamer_id)) { skipped++; return false; } present.add(l.streamer_id); return true; });
        if (!go.length) return;
        const r = await linkParticipantsInTx(tx, matchId, go.map((l) => ({ participant_id: l.participant_id, streamer_id: l.streamer_id })));
        if (r.status !== "ok") { locked += go.length; return; }
        linked += r.linked;
        if (m?.review_completed_at && r.linked > 0) {
          await tx`UPDATE match SET review_completed_at = ${m.review_completed_at}, review_version = ${m.review_version} WHERE match_id = ${matchId}`;
          kept++;
        }
      });
    }
    console.log(`✓ ${linked}자리 연결 · 같은 경기에 이미 있어 건너뜀 ${skipped} · 검수 보호로 건너뜀 ${locked} · 검수 완료 유지 ${kept}경기`);
  }
} finally {
  await closeDb();
}
