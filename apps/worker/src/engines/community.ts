/**
 * 커뮤니티 정기 작업 — 하루 한 번. docs/COMMUNITY-PLAN.md §3 "정기 작업"
 *   삭제 30일 지난 글·댓글 파기(보류 대상 제외) · 처리 30일 지난 신고의 당시 내용 비우기 ·
 *   재가입 제한이 끝난 탈퇴 회원의 로그인 연결 삭제 · 만료 세션 삭제
 * Riot·넥슨을 부르지 않는다(DB 만).
 */

import { runCommunityHousekeep } from "@soop-lol/core/lib/db/community-admin";

import type { EngineResult } from "../job.ts";

/** 상주 루프에서 도는 시각(KST). 사람이 적은 새벽. */
export const COMMUNITY_HOUSEKEEP_HOUR_KST = 4;

export async function runCommunityHousekeepEngine(): Promise<EngineResult> {
  const r = await runCommunityHousekeep();
  return { processed: r.posts + r.comments + r.snapshots + r.identities + r.sessions, detail: r };
}
