/**
 * Engine F — FC 구단(공식 구단가치·스쿼드 6칸) 일일 스냅샷, Engine G — 보유 카드 시세.
 *
 * F 는 **시한부**다. 지나간 날의 구단가치·스쿼드는 다시 구할 수 없다(rank_snapshot 과 같다).
 * G 는 넥슨 시세 그래프가 365일까지 소급해 주므로 하루 빠져도 메워진다 — 예산이 빠듯하면 G 를 줄인다.
 * 둘 다 Riot·Open API 버킷을 쓰지 않는다(FcoSiteClient 의 초당 1회 버킷). F 의 감독명 갱신만 NexonClient 를 쓴다.
 * docs/FCO-CLUB-VALUE-PLAN.md
 */
import { db } from "@soop-lol/core/lib/db/client";
import { heldCards, syncCardPrices, syncClub } from "@soop-lol/core/lib/games/fconline/club/sync";

import { syncValueRanking } from "@soop-lol/core/lib/games/fconline/club/sync-value-ranking";
import { syncRating } from "@soop-lol/core/lib/games/fconline/club/sync-rating";
import { syncTeamColors } from "@soop-lol/core/lib/games/fconline/club/sync-team-colors";

import type { WorkerContext } from "../context.ts";
import type { EngineResult } from "../job.ts";
import { log } from "../log.ts";

export async function runFcoClubEngine(ctx: WorkerContext): Promise<EngineResult> {
  const scope = "engine_f_fco_club";
  if (!ctx.nexon) log.warn(scope, "NEXON_API_KEY 없음 — 저장된 감독명으로 찾는다(감독명이 바뀌었으면 못 찾거나 실패한다)");
  const accounts = await db()<{ ouid: string; slug: string }[]>`
    SELECT link.ouid, s.slug
      FROM streamer_fco_account link
      JOIN streamer s ON s.id = link.streamer_id AND s.visibility = 'public'
     WHERE link.visibility = 'public'
     ORDER BY s.slug, link.ouid`;
  const siteBefore = ctx.fcoSite.callCount;
  let ok = 0;
  const missing: string[] = [];
  const errors: string[] = [];
  for (const account of accounts) {
    const r = await syncClub(ctx.fcoSite, ctx.nexon, account.ouid);
    if (r.outcome === "ok") {
      ok++;
      // 공식경기 티어는 여기서 받지 않는다 — Engine H(runFcoRatingEngine)가 자기 주기로 돈다(2026-10-08 분리).
      try { await syncTeamColors(ctx.fcoSite, account.ouid); }
      catch (e) {
        const reason = `팀컬러: ${e instanceof Error ? e.message : String(e)}`;
        errors.push(`${account.slug}: ${reason}`);
        log.warn(scope, reason, { streamer: account.slug });
      }
    }
    else if (r.outcome === "missing") missing.push(`${account.slug}/${r.nickname}`);
    else {
      errors.push(`${account.slug}/${r.nickname ?? account.ouid}: ${r.reason}`);
      log.warn(scope, r.reason, { streamer: account.slug, nickname: r.nickname });
    }
  }
  try { await syncValueRanking(ctx.fcoSite); }
  catch (e) {
    const reason = `공식 구단가치 순위: ${e instanceof Error ? e.message : String(e)}`;
    errors.push(reason);
    log.warn(scope, reason);
  }
  return {
    processed: ok,
    failed: errors.length,
    detail: {
      accounts: accounts.length, ok,
      siteCalls: ctx.fcoSite.callCount - siteBefore,
      // 없음과 실패를 뭉개지 않는다.
      ...(missing.length ? { missing } : {}),
      ...(errors.length ? { errors } : {}),
    },
  };
}

/**
 * Engine H — FC 공식경기 티어(점수·현재 등급·지난 시즌 최고 등급). 구단가치(F)와 따로 돈다.
 * ★ 왜 분리했나 — F 안에서 스쿼드 저장이 성공한 계정만 티어를 받았다. 목요일 정기 점검 때 스쿼드 조회가
 *   빈 응답이면 그날 티어도 통째로 비었다(2026-10-08). 티어는 다른 주소(rank_inner·TeamInfo)라 점검과 무관하게
 *   받을 수 있고, 신원은 직전에 성공한 구단 스냅샷(감독명·회원번호)으로 확인한다(sync-rating.ts).
 */
export async function runFcoRatingEngine(ctx: WorkerContext): Promise<EngineResult> {
  const scope = "engine_h_fco_rating";
  const accounts = await db()<{ ouid: string; slug: string }[]>`
    SELECT link.ouid, s.slug
      FROM streamer_fco_account link
      JOIN streamer s ON s.id = link.streamer_id AND s.visibility = 'public'
     WHERE link.visibility = 'public'
     ORDER BY s.slug, link.ouid`;
  const siteBefore = ctx.fcoSite.callCount;
  let ok = 0;
  const errors: string[] = [];
  for (const account of accounts) {
    try { await syncRating(ctx.fcoSite, account.ouid); ok++; }
    catch (e) {
      const reason = `공식경기 점수: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(`${account.slug}: ${reason}`);
      log.warn(scope, reason, { streamer: account.slug });
    }
  }
  return {
    processed: ok,
    failed: errors.length,
    detail: { accounts: accounts.length, ok, siteCalls: ctx.fcoSite.callCount - siteBefore,
      ...(errors.length ? { errors } : {}) },
  };
}

export async function runFcoPriceEngine(ctx: WorkerContext): Promise<EngineResult> {
  const siteBefore = ctx.fcoSite.callCount;
  const r = await syncCardPrices(ctx.fcoSite, await heldCards());
  for (const message of r.errors.slice(0, 5)) log.warn("engine_g_fco_prices", message);
  return {
    processed: r.fetched,
    failed: r.errors.length,
    detail: {
      cards: r.cards, fresh: r.fresh, fetched: r.fetched, inserted: r.inserted, revised: r.revised,
      siteCalls: ctx.fcoSite.callCount - siteBefore,
      ...(r.errors.length ? { errors: r.errors } : {}),
    },
  };
}
