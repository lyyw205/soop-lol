/**
 * 이미 저장된 참가자 줄의 상세 지표(perks·challenges)를 수집기 규칙(2026-10-12)에 맞춘다.
 *
 *   npm run trim:participant-detail                  # 미리보기 — 줄 수·크기만
 *   npm run trim:participant-detail -- --apply       # 기록 (200경기씩, 첫 오류에서 멈춘다)
 *   npm run trim:participant-detail -- --vacuum      # 비운 공간을 실제로 돌려받는다(VACUUM FULL)
 *
 * ★ 규칙은 저장 단계와 같다 — 일반인 줄은 둘 다 null(db/ingest.ts saveMatch), 스트리머 줄은 화면이 읽는 값만
 *   (ingest/transform storedChallenges·storedPerks). 같은 함수를 쓰므로 새로 들어오는 줄과 모양이 같다.
 *   스트리머 줄 = 사람이 붙은 자리(streamer_id) 또는 스트리머 계정(streamer_account, 지난 계정 포함)의 puuid.
 * ★ 이 두 칸은 검수 대상 값이 아니라 검수 완료를 풀지 않는다(트리거 0043 이 보는 칸 밖).
 * ★ 운영 DB 가 읽기 전용이어도 --apply 는 트랜잭션만 쓰기로 연다(Supabase 문서의 해제 방법).
 *   그러나 칸을 비우는 것도 새 줄 버전과 WAL 을 **먼저 쓴다** — 2026-10-12 디스크가 꽉 찬 상태에서 돌렸다가
 *   No space left on device 로 멈췄다. 디스크 여유를 대시보드에서 확인한 뒤에만 돌린다.
 * ★ --vacuum 은 표를 새로 쓴다(남는 데이터 크기만큼 디스크 + WAL 이 더 필요하고, 그동안 이 표 읽기가 멈춘다).
 *   VACUUM 은 트랜잭션 안에서 못 돌고 기본 statement_timeout(120초)을 넘기므로 세션 풀러(5432)로 붙는다.
 */
import postgres from "postgres";
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { storedChallenges, storedPerks } from "@soop-lol/core/lib/ingest/transform";

const APPLY = process.argv.includes("--apply");
const VACUUM = process.argv.includes("--vacuum");
const CHUNK = 200, PAUSE_MS = 500;
const ts = () => new Date().toLocaleTimeString("ko-KR", { hour12: false });

// jsonb 는 키 순서를 바꿔 돌려주므로 비교는 키를 정렬해서 한다.
const canon = (v: unknown): string =>
  v === null || typeof v !== "object" ? JSON.stringify(v ?? null)
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;

const sql = db();
try {
  if (!VACUUM || APPLY) {
    const [s] = await sql<{ other: number; other_mb: number; mine: number; mine_mb: number }[]>`
      SELECT count(*) FILTER (WHERE NOT s)::int AS other, (sum(b) FILTER (WHERE NOT s) / 1048576)::int AS other_mb,
             count(*) FILTER (WHERE s)::int AS mine, (sum(b) FILTER (WHERE s) / 1048576)::int AS mine_mb
        FROM (SELECT (mp.streamer_id IS NOT NULL OR EXISTS (SELECT 1 FROM streamer_account sa WHERE sa.puuid = mp.puuid)) AS s,
                     coalesce(pg_column_size(mp.challenges), 0) + coalesce(pg_column_size(mp.perks), 0) AS b
                FROM match_participant mp WHERE mp.challenges IS NOT NULL OR mp.perks IS NOT NULL) x`;
    console.log(`상세 지표가 있는 줄 — 일반인 ${s.other}줄(${s.other_mb ?? 0}MB → 비움) · 스트리머 ${s.mine}줄(${s.mine_mb ?? 0}MB → 쓰는 값만)`
      + (APPLY ? "" : "   [미리보기 — --apply 로 기록]"));
  }
  if (APPLY) {
    const ids = (await sql<{ match_id: string }[]>`
      SELECT DISTINCT match_id FROM match_participant WHERE challenges IS NOT NULL OR perks IS NOT NULL ORDER BY 1`).map((r) => r.match_id);
    let cleared = 0, trimmed = 0, kept = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      await sql.begin("read write", async (tx) => {
        cleared += (await tx`
          UPDATE match_participant mp SET challenges = NULL, perks = NULL
           WHERE mp.match_id = ANY(${chunk}) AND (mp.challenges IS NOT NULL OR mp.perks IS NOT NULL) AND mp.streamer_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM streamer_account sa WHERE sa.puuid = mp.puuid)`).count;
        const rows = await tx<{ match_id: string; participant_id: number; challenges: Record<string, unknown> | null; perks: unknown }[]>`
          SELECT match_id, participant_id, challenges, perks FROM match_participant
           WHERE match_id = ANY(${chunk}) AND (challenges IS NOT NULL OR perks IS NOT NULL)`;
        const change = rows.flatMap((r) => {
          const c = r.challenges === null ? null : storedChallenges(r.challenges);
          const p = storedPerks(r.perks);
          if (canon(c) === canon(r.challenges) && canon(p) === canon(r.perks)) { kept++; return []; }
          return [{ match_id: r.match_id, participant_id: r.participant_id, c, p }];
        });
        if (change.length) {
          await tx`
            UPDATE match_participant mp SET challenges = v.c, perks = v.p
              FROM jsonb_to_recordset(${tx.json(change as never)}) AS v(match_id text, participant_id int, c jsonb, p jsonb)
             WHERE mp.match_id = v.match_id AND mp.participant_id = v.participant_id`;
          trimmed += change.length;
        }
      });
      const k = i / CHUNK + 1;
      if (k % 10 === 0 || i + CHUNK >= ids.length) console.log(`${ts()} 경기 ${Math.min(i + CHUNK, ids.length)}/${ids.length} · 비움 ${cleared} · 줄임 ${trimmed} · 이미 맞음 ${kept}`);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    console.log(`✓ 일반인 줄 비움 ${cleared} · 스트리머 줄 줄임 ${trimmed} · 이미 맞음 ${kept}`);
  }
  if (VACUUM) {
    const u = new URL(process.env.DATABASE_URL!);
    if (u.port === "6543") u.port = "5432";   // Supabase 트랜잭션 풀러 → 세션 풀러
    const s = postgres(u.toString(), { max: 1, prepare: false, idle_timeout: 20 });
    try {
      const size = async () => (await s<{ db: string; mp: string }[]>`
        SELECT pg_size_pretty(pg_database_size(current_database())) AS db, pg_size_pretty(pg_total_relation_size('match_participant')) AS mp`)[0];
      await s`SET statement_timeout = 0`;
      await s`SET lock_timeout = '30s'`;
      const before = await size();
      console.log(`${ts()} VACUUM FULL 시작 — DB ${before.db} · 참가자 표 ${before.mp}`);
      const t0 = Date.now();
      await s.unsafe("VACUUM (FULL, ANALYZE) match_participant");
      const after = await size();
      console.log(`${ts()} ✓ ${Math.round((Date.now() - t0) / 1000)}초 — DB ${before.db} → ${after.db} · 참가자 표 ${before.mp} → ${after.mp}`);
    } finally {
      await s.end({ timeout: 5 });
    }
  }
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`${ts()} 멈춤 ${err.code ?? ""} ${err.message ?? e}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
