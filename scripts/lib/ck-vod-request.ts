/**
 * VOD 판독 요청(0097) → 이번 회차의 할 일. DB·SOOP 를 모르는 순수 함수다 — ck:queue plan 이 사실을 모아 넘기고 결과대로 쓴다.
 * docs/SUBMISSION-POLICY-PLAN.md §6
 *
 *   영상 없음(접근 불가 기록)          → 요청을 unavailable 로 닫는다
 *   조사가 끝났고 이 PC 가 처음 본 요청 → 조사를 다시 연다 + 대기열 맨 앞(회원이 등록한 뒤라 그 판을 아직 안 봤을 수 있다)
 *   조사가 끝났고 이미 대기열에 넣었던 요청 → 그 다시 연 조사가 끝났다 — done 으로 닫는다
 *   할 일이 남았다                     → 대기열 맨 앞(감시 목록 밖 채널이어도)
 *   VOD 정보를 못 구했다                → 그대로 둔다(다음 회차가 다시 본다) · 반복 제한에 걸렸다 → 그대로 두고 알린다
 */
import type { OpenVodRequest } from "@soop-lol/core/lib/db/vod-request";
import type { VodWork } from "@soop-lol/core/lib/metrics/ck-vod-status";

import type { AutoVod } from "./ck-auto-queue.ts";

/** 대기열 한 줄에 필요한 VOD 정보(우선순위·사유 빼고). */
export type VodMeta = Omit<AutoVod, "reason" | "priority">;

export interface RequestFacts {
  meta: VodMeta | null;
  work: VodWork;
  /** event_lead 의 scan.status — 다시 열 수 있는 것은 done 뿐이다. */
  scan_status: string | null;
  /** 결과 진척 없이 반복 제한에 걸렸다(ck-backfill-guard). */
  blocked: boolean;
}

export interface RequestPlan {
  enqueue: AutoVod[];
  reopen: number[];
  claim: { title_no: number; channel_id: string }[];
  close: { title_no: number; state: "done" | "unavailable"; note: string }[];
  waiting: { title_no: number; why: string }[];
}

const REASON_LABEL: Record<string, string> = { submission: "회원 제보", admin: "운영자" };

export function planVodRequests(requests: readonly OpenVodRequest[], facts: ReadonlyMap<number, RequestFacts>): RequestPlan {
  const out: RequestPlan = { enqueue: [], reopen: [], claim: [], close: [], waiting: [] };
  for (const r of requests) {
    const f = facts.get(r.title_no);
    if (!f) { out.waiting.push({ title_no: r.title_no, why: "VOD 정보를 못 읽었다" }); continue; }
    if (f.work.unavailable) { out.close.push({ title_no: r.title_no, state: "unavailable", note: "접근 불가로 기록된 VOD" }); continue; }
    let reason = f.work.reason as string | null;
    if (reason === null && (r.state === "claimed" || f.scan_status !== "done")) {
      out.close.push({ title_no: r.title_no, state: "done", note: r.state === "claimed" ? "요청 뒤 판독 끝" : "조사할 것이 없음" });
      continue;
    }
    if (!f.meta) { out.waiting.push({ title_no: r.title_no, why: "채널·방송 시각을 모른다" }); continue; }
    if (reason === null) {
      // 다시 열면 반복 제한도 지워진다(reopen 이 지운다) — 새 요청은 새 조사다.
      out.reopen.push(r.title_no);
      reason = "running";
    } else if (f.blocked) { out.waiting.push({ title_no: r.title_no, why: "결과 진척 없이 반복 제한에 걸렸다" }); continue; }
    if (r.state === "queued") out.claim.push({ title_no: r.title_no, channel_id: f.meta.channel_id });
    const who = r.reasons.map((x) => REASON_LABEL[x] ?? x).join("·");
    // 요청 메모는 세션 지시문의 "대상 사유"로 넘어간다 — 회원 글은 db/submission.ts 가 시점·등록 이름으로만 줄여 적는다.
    const notes = r.notes.join(" / ").replace(/[\t\r\n]+/g, " ").slice(0, 200);
    out.enqueue.push({ ...f.meta, priority: r.priority, reason: `${reason} · ${who} 판독 요청${notes ? ` (${notes})` : ""}` });
  }
  return out;
}
