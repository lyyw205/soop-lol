/**
 * 로컬 개발용 임시 Postgres.
 *
 * Supabase 프로젝트가 없어도 화면을 띄워 볼 수 있게, PGlite(WASM Postgres)를
 * 진짜 포트에 물려 준다. 스키마를 적용하고 시드 몇 줄을 넣은 뒤 계속 떠 있는다.
 *
 *   npm run dev:db          # 터미널 1
 *   npm run dev             # 터미널 2 (apps/web/.env.local 에 아래 두 줄)
 *
 * ⚠️ **메모리 DB다. 끄면 전부 사라진다.** 실제 데이터는 Supabase 로 간다.
 *
 * ⚠️ **DATABASE_POOL_MAX=1 이 필수다.**
 *   PGlite 소켓 서버는 동시 연결을 받지 못한다 — 커넥션이 2개가 되는 순간
 *   `read ECONNRESET` 으로 죽는다. 앱 코드의 문제가 아니라 이 하네스의 한계다.
 *   (실제 Postgres 에서는 Promise.all 로 병렬 질의하는 게 맞고, 그대로 둔다)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { applyAll } from "./lib/migrations.ts";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.DEV_DB_PORT ?? 5433);

const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
await applyAll((sql) => db.exec(sql), ROOT, { includeModules: true });

if (process.env.DEV_DB_SEED !== "0") {
  await db.exec(`
    -- ⚠ 채널은 streamer 컬럼이 아니라 별도 테이블이다. 0004 가 1:1(platform_user_id·
    --    channel_url)을 1:N(streamer_channel)으로 옮기면서 저 두 컬럼을 지웠는데
    --    이 시드가 따라오지 않아 dev:db 가 계속 죽고 있었다.
    INSERT INTO streamer (slug, display_name, is_pro, aliases)
    VALUES
      ('sample_a', '샘플 스트리머 A', false, ARRAY['샘플에이']),
      ('sample_b', '샘플 스트리머 B', true,  ARRAY['샘플비']);

    INSERT INTO streamer_channel (streamer_id, platform, channel_id, channel_url, label, is_primary)
    SELECT s.id, 'soop', s.slug, 'https://ch.sooplive.co.kr/' || s.slug, '본채널', true
      FROM streamer s WHERE s.slug IN ('sample_a', 'sample_b');

    INSERT INTO riot_account (puuid, game_name, tag_line, summoner_level)
    VALUES
      (repeat('a', 78), '샘플에이', 'KR1', 412),
      (repeat('b', 78), '샘플비',   'KR1', 388);

    INSERT INTO streamer_account (streamer_id, puuid, label, is_main, confidence, evidence)
    SELECT s.id, repeat('a', 78), '본계', true, 'verified',
           '{"source":"broadcast_notice","url":"https://example.com/proof"}'::jsonb
      FROM streamer s WHERE s.slug = 'sample_a';

    INSERT INTO streamer_account (streamer_id, puuid, label, is_main, confidence, evidence)
    SELECT s.id, repeat('b', 78), '본계', true, 'likely',
           '{"source":"community_post","note":"커뮤니티 정리글 기준 — 재확인 필요"}'::jsonb
      FROM streamer s WHERE s.slug = 'sample_b';

    INSERT INTO rank_snapshot (puuid, queue_type, snapshot_date, tier, division, league_points, wins, losses)
    VALUES
      (repeat('a', 78), 'RANKED_SOLO_5x5', current_date, 'DIAMOND', 'I', 42, 120, 104),
      (repeat('b', 78), 'RANKED_SOLO_5x5', current_date, 'MASTER',  'I', 213, 240, 198);

    INSERT INTO career_event (streamer_id, title, placement, role)
    SELECT s.id, '2026 SOOP 멸망전', '준우승', '선수' FROM streamer s WHERE s.slug = 'sample_b';

    INSERT INTO ingest_cursor (puuid) VALUES (repeat('a', 78)), (repeat('b', 78));
  `);

  await seedCkReview();
}

/**
 * CK 판독 검수 화면(`/admin/ck`)이 빈 화면이 아니게 시드를 넣는다.
 *
 * ★ **실제로 뽑아 둔 프레임**(`out/ck/<날짜>/manifest.json`)을 읽어 그 경로를 쓴다.
 *   가짜 경로를 넣으면 화면은 뜨지만 이미지가 전부 404 라, 정작 검수하려는 것
 *   — "이 프레임을 보고 이렇게 판단했구나" — 를 확인할 수 없다.
 *   프레임이 없으면(디스크를 비웠거나 아직 안 뽑았으면) 조용히 건너뛴다.
 */
async function seedCkReview(): Promise<void> {
  const ckDir = join(ROOT, "out", "ck");
  if (!existsSync(ckDir)) return;

  // manifest 가 있는 날짜 중 프레임이 제일 많은 하나를 고른다.
  const picked = readdirSync(ckDir)
    .map((date) => join(ckDir, date, "manifest.json"))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as DevManifest)
    .map((m) => ({ manifest: m, vod: m.sessions?.[0]?.vods?.[0] }))
    .filter((x): x is { manifest: DevManifest; vod: DevVod } => Boolean(x.vod?.files?.[0]?.frames?.length))
    .sort((a, b) => (b.vod.files[0].frames.length - a.vod.files[0].frames.length))[0];
  if (!picked) return;

  const { manifest, vod } = picked;
  const frames = vod.files[0].frames.slice(0, 24);

  const [lead] = await db.query<{ id: string }>(
    `INSERT INTO event_lead (source, source_key, url, channel_id, title, observed_at, raw, state)
     VALUES ('vod_title', $1, $2, $3, $4, $5, $6, 'confirmed')
     RETURNING id`,
    [
      `vod:${vod.title_no}`,
      vod.vod_url ?? `https://vod.sooplive.com/player/${vod.title_no}`,
      vod.channel_id,
      vod.title,
      vod.ended_at ?? new Date().toISOString(),
      JSON.stringify({ scan: { status: "done", signals: ["pixel"], version: "dev-seed" } }),
    ],
  ).then((r) => r.rows);

  // 결과창 프레임이 있으면 그걸로 경기 하나를 만들어 둔다 — 인스펙터가 채워진 모습을 봐야 한다.
  const resultFrame = frames.find((f) => f.kind === "result");
  let matchId: string | null = null;
  if (resultFrame) {
    matchId = `dev-ck:${vod.title_no}:g1`;
    await db.query(
      `INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, game_creation, game_duration,
                          winning_team, source, origin, source_url)
       VALUES ($1, 'lol', 0, '0', 'CUSTOM', $2, 1800, 100, 'manual', 'vod_scan', $3)`,
      [matchId, vod.ended_at ?? new Date().toISOString(), vod.vod_url ?? null],
    );
    await db.query(
      `INSERT INTO review_record (match_id, type, body, created_by)
       VALUES ($1, 'final_evidence', $2, 'auto')`,
      [matchId, `${resultFrame.at} 결과창 (개발 시드)`],
    );
    const people = await db.query<{ id: string; puuid: string }>(
      `SELECT s.id, sa.puuid FROM streamer s JOIN streamer_account sa ON sa.streamer_id = s.id
        ORDER BY s.slug`,
    );
    for (const [i, p] of people.rows.entries()) {
      await db.query(
        `INSERT INTO match_participant
           (match_id, puuid, streamer_id, participant_id, team_id, side_no, team_position,
            champion_id, champion_name, outcome, kills, deaths, assists)
         VALUES ($1, $2, $3, $4, $5, $6, 'MIDDLE', $7, $8, $9, $10, $11, $12)`,
        [matchId, p.puuid, p.id, i + 1, i === 0 ? 100 : 200,
          i === 0 ? 1 : 2, i === 0 ? 157 : 238, i === 0 ? 'Yasuo' : 'Zed',
          i === 0 ? 'win' : 'loss',
          // 두 번째 사람은 KDA 를 못 읽은 것으로 둔다 — NULL 이 '—' 로 그려지는지 봐야 한다.
          i === 0 ? 5 : null, i === 0 ? 1 : null, i === 0 ? 3 : null],
      );
    }
    // 이름만 읽고 사람을 못 붙인 자리도 하나 — 그 칸이 화면에 어떻게 보이는지 확인용.
    await db.query(
      `INSERT INTO match_participant
         (match_id, observed_name, participant_id, team_id, side_no, team_position,
          champion_id, outcome)
       VALUES ($1, '난벌레팡이다', 3, 200, 2, 'TOP', 86, 'loss')`,
      [matchId],
    );
  }

  // ★ 일부는 **읽은 것**(note + read_at), 일부는 **뽑기만 한 것**(note 없음)으로 둔다.
  //   화면에서 둘이 구분돼 보이는지가 이 시드로 확인하려는 것 중 하나다.
  for (const [i, f] of frames.entries()) {
    const isResult = f.kind === "result";
    const read = isResult || i % 3 === 0;
    const note = read ? (isResult ? "결과창 — 승패·라인업 확인" : "인게임 화면") : null;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, at_sec, kind, read_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [lead.id, isResult ? matchId : null,
        `out/ck/${manifest.date}/${f.file}`, f.at_sec, isResult ? "result" : "other",
        read ? new Date().toISOString() : null],
    );
    if (note) await db.query(
      `INSERT INTO review_record (lead_id, frame_id, type, body, created_by)
       VALUES ($1, $2, 'observation', $3, 'auto')`,
      [lead.id, inserted.rows[0].id, note],
    );
  }

  // 후보 — 경기가 된 것 · 미해결 · 대상 아님을 각각 하나씩. 화면이 셋을 구분해야 한다.
  const resultAt = frames.find((f) => f.kind === "result")?.at_sec ?? 0;
  const lastAt = frames[frames.length - 1]?.at_sec ?? resultAt + 600;
  await db.query(
    `UPDATE event_lead SET raw = raw || $2::jsonb WHERE id = $1`,
    [lead.id, JSON.stringify({
      candidates: [
        matchId && {
          id: "g1", at: [Math.max(0, resultAt - 1800), resultAt + 120], conclusion: "match",
          observed: "결과창 점수판 · 10명 인게임명과 챔피언",
          why: "승패와 라인업을 결과창에서 직접 읽었다", match_id: matchId,
        },
        {
          id: "g2", at: [resultAt + 600, resultAt + 2400], conclusion: "unresolved",
          observed: "롤 화면이지만 결과창을 못 찾았다",
          why: "경기 경계는 보이는데 승패 근거가 없어 경기로 넣지 않았다",
          open_questions: ["다른 참가자 시점에 결과창이 있는지", "채팅 공지가 있는지"],
        },
        {
          id: "g3", at: [Math.max(0, lastAt - 600), lastAt], conclusion: "not_target",
          observed: "중계 오버레이와 프로 선수 이름",
          why: "본인 경기가 아니라 시청 구간이다",
        },
      ].filter(Boolean),
      scan: {
        status: "done", version: "dev-seed",
        requested: [[0, lastAt]], sampled: [[0, lastAt]],
        probes: { planned: frames.filter((_, i) => i % 4 === 0).map((f) => f.at_sec) },
        opened: frames.filter((f) => f.kind === "result").map((f) => f.at_sec),
        failed: [[lastAt, lastAt + 900]],
        signals: ["pixel"],
      },
    })],
  );
  await db.query(
    `INSERT INTO review_record (lead_id, candidate_id, type, body, created_by)
     SELECT el.id, c->>'id', v.type, v.body, 'auto'
       FROM event_lead el
       CROSS JOIN LATERAL jsonb_array_elements(el.raw->'candidates') c
       CROSS JOIN LATERAL (VALUES
         ('observation', NULLIF(c->>'observed','')),
         ('assessment', NULLIF(c->>'why',''))
       ) v(type, body)
      WHERE el.id=$1 AND v.body IS NOT NULL`,
    [lead.id],
  );
  await db.query(
    `INSERT INTO review_record (lead_id, candidate_id, type, body, created_by)
     SELECT el.id, c->>'id', 'question', q.value, 'auto'
       FROM event_lead el
       CROSS JOIN LATERAL jsonb_array_elements(el.raw->'candidates') c
       CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c->'open_questions','[]'::jsonb)) q(value)
      WHERE el.id=$1`,
    [lead.id],
  );
  // 후보 JSON 에는 구조만 남긴다 — 서술은 위에서 옮긴 review_record 가 정본이다(0040).
  await db.query(
    `UPDATE event_lead SET raw = jsonb_set(raw, '{candidates}', (
       SELECT jsonb_agg(c - 'observed' - 'why' - 'open_questions' ORDER BY ord)
         FROM jsonb_array_elements(raw->'candidates') WITH ORDINALITY t(c, ord)))
      WHERE id=$1`,
    [lead.id],
  );

  console.log(`CK 검수 시드: ${vod.title} — 프레임 ${frames.length}장`
    + `${matchId ? " · 경기 1개" : ""} · 후보 3건(미해결 1)`);
}

interface DevFrame { file: string; at: string; at_sec: number; kind: string }
interface DevVod {
  channel_id: string; title: string; title_no: number;
  vod_url?: string; ended_at?: string;
  files: { frames: DevFrame[] }[];
}
interface DevManifest { date: string; sessions?: { vods?: DevVod[] }[] }

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();

/**
 * 파생 테이블은 **core 의 진짜 함수로** 만든다.
 *
 * ★ 조우·챔피언 통계를 시드 SQL 로 손으로 넣지 않는다 — 파생 규칙이 두 벌이 되고,
 *   개발 화면이 실제와 다른 값을 보여주게 된다(원칙 5·6). 그래서 소켓이 열린 뒤에
 *   core 클라이언트로 붙어 재파생을 부르고, **곧바로 닫는다** —
 *   PGlite 는 동시 연결을 못 받으므로 개발 서버가 쓸 커넥션을 비워 둬야 한다.
 */
if (process.env.DEV_DB_SEED !== "0") {
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  process.env.DATABASE_POOL_MAX = "1";
  const { closeDb } = await import("../packages/core/lib/db/client.ts");
  const { rederiveEncounters, recomputeChampionStats } = await import("../packages/core/lib/db/ingest.ts");
  const ids = (await db.query<{ match_id: string }>(`SELECT match_id FROM match`)).rows
    .map((r) => r.match_id);
  if (ids.length > 0) {
    const pairs = await rederiveEncounters(ids);
    const stats = await recomputeChampionStats();
    console.log(`파생: 조우 ${pairs}쌍 · 챔피언 통계 ${stats}행`);
  }
  await closeDb();
}

console.log(`임시 Postgres 준비됨 (메모리, 끄면 사라짐)`);
console.log(`apps/web/.env.local 에 아래 두 줄을 넣고 npm run dev:`);
console.log(`  DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres`);
console.log(`  DATABASE_POOL_MAX=1   # ★ PGlite 는 동시 연결을 못 받는다. 빼면 ECONNRESET`);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
