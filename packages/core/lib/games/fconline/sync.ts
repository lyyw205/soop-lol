import { db } from "../../db/client.ts";
import { saveFcoMatch } from "./ingest.ts";
import type { FcoMatchDetail } from "./types.ts";
import { fcoMatchStartMs } from "./timeline.ts";

/**
 * FC 경기 수집 한 계정분 — 워커(engine_e_fco)와 수동 CLI(fco:sync)가 같은 함수를 쓴다.
 * 여기서 갈라 세는 세 가지를 뭉개지 않는다 (FCO-MATCH-CONTEXT-SKILL-PLAN 데이터 계약 2):
 *   조회 실패(listed='error') ≠ 조회 성공 후 0건(listed=0) ≠ 저장 모델 밖(unsupported).
 */

export interface FcoSyncSource {
  matchIds(ouid: string, matchtype: number, offset: number, limit: number): Promise<string[]>;
  matchDetail(matchId: string): Promise<FcoMatchDetail | null>;
}

/**
 * 타입별 목록을 어디까지 봤나.
 *   end        목록 끝까지 받았다 — 넥슨이 주는 전부(실측: 한국 날짜 기준 최근 30일)
 *   caught_up  지난번에 빈틈없이 읽은 지점(fco_account.list_synced_until)까지 내려왔다
 *   capped     페이지 상한(maxPages)에 걸렸다 — 더 있을 수 있다
 *   error      목록 조회가 실패했다 — 받은 데까지만 처리했다
 */
export type FcoListCoverage = "end" | "caught_up" | "capped" | "error";

export interface FcoSyncResult {
  /** 매치 타입별로 목록에서 받은 경기 수. 숫자 0은 "정말 0건", 'error' 는 "첫 페이지부터 조회 실패"다. */
  listed: Record<string, number | "error">;
  /** 타입별로 목록을 어디까지 봤나 — "100건 받음" 과 "끝까지 받음" 을 가른다. */
  coverage: Record<string, FcoListCoverage>;
  /** 모든 타입을 빈틈없이 읽어 계정 커서를 앞으로 옮겼나. false 면 다음 수집이 다시 끝까지 본다. */
  cursorAdvanced: boolean;
  /** 이미 저장돼 있어 상세 조회를 건너뜀 (경기 종료 후 상세는 불변으로 관측됨). */
  known: number;
  saved: number;
  /** 1:1 외 등 현재 저장 모델 밖. 실패도 부재도 아니다 — 지원 범위 확대의 근거로 남는다. */
  unsupported: number;
  /** 상세 404. */
  missing: number;
  errors: string[];
}

/** 넥슨 목록 한 페이지 최대치. */
const PAGE_SIZE = 100;
/** 커서보다 이만큼 더 내려간다 — 커서 직전에 시작해 그 뒤에 끝난 경기가 목록에 늦게 들어온다. */
const CURSOR_SLACK_MS = 2 * 3600_000;

/**
 * 목록은 최신순이다. 규칙은 하나 — **이 계정의 목록을 지난번에 끝까지 읽은 지점까지 넘긴다.**
 *   · 새 계정(커서 없음): 목록 끝(30일)까지 간다
 *   · 매일 수집: 어제 읽은 지점에서 멈춘다 — 하루에 몇 판을 했든 빠지지 않는다
 * ★ 넥슨은 30일이 지난 경기를 목록에서 지운다(docs/FCO-TIME-SAMPLES.md). 한 페이지만 받던
 *   시절 새 계정의 옛 경기가 그대로 사라졌다(2026-09-25 뿌챔스 4경기).
 * ★ 「이미 저장된 경기」에서 멈추지 않는다 — 상대 스트리머 목록으로 들어온 경기일 수 있어서,
 *   새 계정이 첫 페이지에서 멈춰 버린다. 저장된 경기는 상세 조회만 건너뛴다.
 * 커서는 모든 타입을 빈틈없이 읽었을 때만 옮긴다. 실패·상한이 하나라도 있으면 그대로 둔다.
 * refetchKnown 이면 커서를 무시하고 끝까지 가며 저장된 경기의 상세도 다시 받는다(수동 재수집).
 */
export async function syncFcoMatches(
  source: FcoSyncSource,
  ouid: string,
  opts: { types: number[]; refetchKnown?: boolean; maxPages?: number },
): Promise<FcoSyncResult> {
  const result: FcoSyncResult = {
    listed: {}, coverage: {}, cursorAdvanced: false, known: 0, saved: 0, unsupported: 0, missing: 0, errors: [],
  };
  const maxPages = opts.maxPages ?? 20;
  const sql = db();
  const [account] = await sql<{ list_synced_until: Date | null }[]>`
    SELECT list_synced_until FROM fco_account WHERE ouid = ${ouid}
  `;
  const cursorMs = account?.list_synced_until ? new Date(account.list_synced_until).getTime() : null;
  const stopBeforeMs = opts.refetchKnown || cursorMs == null ? null : cursorMs - CURSOR_SLACK_MS;

  const fetchList: string[] = [];
  const seen = new Set<string>();
  let newestMs: number | null = null;

  for (const type of opts.types) {
    const key = String(type);
    let listed = 0;
    let coverage: FcoListCoverage = "capped";
    pages: for (let page = 0; page < maxPages; page++) {
      let ids: string[];
      try {
        ids = await source.matchIds(ouid, type, page * PAGE_SIZE, PAGE_SIZE);
      } catch (e) {
        result.errors.push(`목록 조회 실패 type=${type} offset=${page * PAGE_SIZE}: ${e instanceof Error ? e.message : String(e)}`);
        coverage = "error";
        break;
      }
      const existing = ids.length ? await sql<{ provider_match_id: string }[]>`
        SELECT provider_match_id FROM fco_match_detail WHERE provider_match_id = ANY(${ids})
      ` : [];
      const knownIds = new Set(existing.map((r) => r.provider_match_id));
      for (const id of ids) {
        const startMs = fcoMatchStartMs(id);
        if (stopBeforeMs != null && startMs != null && startMs < stopBeforeMs) {
          coverage = "caught_up";
          break pages;
        }
        listed++;
        if (startMs != null && (newestMs == null || startMs > newestMs)) newestMs = startMs;
        if (seen.has(id)) continue;
        seen.add(id);
        if (knownIds.has(id)) {
          result.known++;
          if (!opts.refetchKnown) continue;
        }
        fetchList.push(id);
      }
      if (ids.length < PAGE_SIZE) { coverage = "end"; break; }
    }
    result.listed[key] = coverage === "error" && listed === 0 ? "error" : listed;
    result.coverage[key] = coverage;
  }

  for (const id of fetchList) {
    try {
      const detail = await source.matchDetail(id);
      if (!detail) { result.missing++; continue; }
      if (await saveFcoMatch(detail) === "saved") result.saved++;
      else result.unsupported++;
    } catch (e) {
      result.errors.push(`상세 실패 ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 커서는 목록을 빈틈없이 읽고 상세까지 전부 받았을 때만 옮긴다 — 실패가 섞이면 다음에 다시 본다.
  const complete = Object.values(result.coverage).every((c) => c === "end" || c === "caught_up")
    && result.errors.length === 0;
  if (complete) {
    const next = Math.max(newestMs ?? 0, cursorMs ?? 0);
    if (next > 0) {
      await sql`UPDATE fco_account SET list_synced_until = ${new Date(next)} WHERE ouid = ${ouid}`;
      result.cursorAdvanced = true;
    }
  }
  return result;
}
