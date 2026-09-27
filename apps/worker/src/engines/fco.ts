/**
 * Engine E — FC 온라인 일일 수집.
 *
 * 연결된 공개 계정마다 경기 목록을 당겨 새 경기만 저장한다. Riot 루프와 레이트리밋
 * 버킷이 다르므로 순서만 공유하고 호출 예산은 섞지 않는다 (NexonClient 가 따로 든다).
 *
 * 계정마다 커서(fco_account.list_synced_until)까지 목록을 넘긴다 — 새 계정은 30일 끝까지,
 * 매일은 어제 읽은 지점까지. 넥슨은 30일 지난 경기를 지우므로(docs/FCO-TIME-SAMPLES.md)
 * 「최근 N건」으로 자르면 많이 한 날·새 계정의 경기가 영구히 빠진다.
 * 커서를 못 옮긴 계정(목록 실패·상한)은 detail.incomplete 에 남는다 — 다음 날 다시 끝까지 본다.
 */
import { db } from "@soop-lol/core/lib/db/client";
import { syncFcoMatches } from "@soop-lol/core/lib/games/fconline/sync";

import type { WorkerContext } from "../context.ts";
import type { EngineResult } from "../job.ts";
import { log } from "../log.ts";

const SCOPE = "engine_e_fco";

export async function runFcoEngine(ctx: WorkerContext): Promise<EngineResult> {
  if (!ctx.nexon) {
    log.info(SCOPE, "NEXON_API_KEY 없음 — FC 수집 건너뜀 (실패가 아니라 미설정이다)");
    return { processed: 0, detail: { skipped: "no_api_key" } };
  }
  const sql = db();
  const accounts = await sql<{ ouid: string; slug: string }[]>`
    SELECT link.ouid, s.slug
      FROM streamer_fco_account link
      JOIN streamer s ON s.id = link.streamer_id AND s.visibility = 'public'
     WHERE link.visibility = 'public'
     ORDER BY s.slug
  `;
  const callsBefore = ctx.nexon.callCount;
  let saved = 0, known = 0, unsupported = 0, missing = 0;
  const listErrors: string[] = [];
  const incomplete: string[] = [];  // 목록을 빈틈없이 못 읽은 계정 — 커서가 안 움직였다

  for (const account of accounts) {
    const r = await syncFcoMatches(ctx.nexon, account.ouid, {
      types: ctx.cfg.fcoMatchtypes,
    });
    saved += r.saved; known += r.known; unsupported += r.unsupported; missing += r.missing;
    for (const [type, n] of Object.entries(r.listed)) {
      if (n === "error") listErrors.push(`${account.slug}/type${type}`);
    }
    if (!r.cursorAdvanced) incomplete.push(account.slug);
    for (const message of r.errors) log.warn(SCOPE, message);
  }

  return {
    processed: saved,
    detail: {
      accounts: accounts.length,
      saved, known, unsupported, missing,
      nexonCalls: ctx.nexon.callCount - callsBefore,
      // 실패와 0건을 뭉개지 않는다 — 실패한 (계정, 타입)만 여기 남는다.
      ...(listErrors.length ? { listErrors } : {}),
      ...(incomplete.length ? { incomplete } : {}),
    },
  };
}
