/**
 * VOD 판독 요청(0097) 읽기·쓰기의 단일 출처. docs/SUBMISSION-POLICY-PLAN.md §6
 *
 *   웹    requestVodInTx(제보 판정이 — 2단계 ④⑤) · requestVodByAdmin · cancelVodRequest · listVodRequestsForAdmin
 *   이 PC listOpenVodRequests(ck:queue plan 이 VOD 로 묶어 읽는다) · claimVodRequests
 *         · 닫기는 submission.ts settleVodRequests(닫고 그 제보들을 다시 판정 — 한 트랜잭션)
 *
 * ★ 줄은 (VOD, 제보)마다 하나, 읽을 때 VOD 로 묶는다. 같은 VOD 의 열린 줄은 상태가 함께 움직인다(claim·close 가 VOD 단위).
 * ★ 이 파일은 대기열을 모른다 — 대기열 순서는 scripts/lib/ck-auto-queue.ts, 요청 → 대기열은 scripts/lib/ck-vod-request.ts.
 */
import type postgres from "postgres";

import {
  soopVodId, VOD_REQUEST_PRIORITY, type VodRequestReason, type VodRequestState,
} from "../metrics/vod-request.ts";
import { db } from "./client.ts";
import { MemberError } from "./member.ts";

type Tx = postgres.TransactionSql;
type Sql = postgres.Sql | Tx;

/** 화면에 그대로 보여 주는 요청 거부. */
export class VodRequestError extends MemberError {
  constructor(message: string) { super(message); this.name = "VodRequestError"; }
}

export interface VodRequestInput {
  title_no: number;
  reason: VodRequestReason;
  /** reason = submission 일 때 그 제보. */
  submission_id?: string | null;
  requested_by: string;
  note?: string | null;
  channel_id?: string | null;
}

const cleanNote = (s: string | null | undefined) => {
  const t = String(s ?? "").trim();
  if (t.length > 500) throw new VodRequestError("메모는 500자까지 쓸 수 있습니다.");
  return t || null;
};

/**
 * 요청 한 줄 — 이미 있으면 그대로(같은 제보 × 같은 VOD, 운영자 요청은 VOD 마다 열린 것 하나). 새로 썼으면 created.
 * 요청한 쪽의 트랜잭션 안에서 부른다(제보 접수와 같은 트랜잭션 — 둘 중 하나만 남지 않는다).
 */
export async function requestVodInTx(tx: Tx, r: VodRequestInput, now = new Date()): Promise<{ created: boolean }> {
  if (!Number.isSafeInteger(r.title_no) || r.title_no <= 0) throw new VodRequestError("VOD 번호가 올바르지 않습니다.");
  if ((r.reason === "submission") !== !!r.submission_id) throw new Error("제보 요청에는 제보 번호가, 운영자 요청에는 없어야 한다");
  if (r.channel_id != null && !/^[A-Za-z0-9_-]+$/.test(r.channel_id)) throw new VodRequestError("채널 아이디가 올바르지 않습니다.");
  const note = cleanNote(r.note);
  const priority = VOD_REQUEST_PRIORITY[r.reason];
  const rows = r.submission_id
    ? await tx`
        INSERT INTO vod_request (title_no, channel_id, priority, reason, submission_id, note, requested_by, requested_at)
        VALUES (${r.title_no}, ${r.channel_id ?? null}, ${priority}, ${r.reason}, ${r.submission_id}::uuid, ${note}, ${r.requested_by}, ${now})
        ON CONFLICT (title_no, submission_id) WHERE submission_id IS NOT NULL DO NOTHING RETURNING id`
    : await tx`
        INSERT INTO vod_request (title_no, channel_id, priority, reason, note, requested_by, requested_at)
        VALUES (${r.title_no}, ${r.channel_id ?? null}, ${priority}, ${r.reason}, ${note}, ${r.requested_by}, ${now})
        ON CONFLICT (title_no) WHERE submission_id IS NULL AND state IN ('queued', 'claimed') DO NOTHING RETURNING id`;
  return { created: rows.length > 0 };
}

/** 운영자 요청 — 링크나 번호. 이미 열린 운영자 요청이 있으면 그대로(created false). */
export async function requestVodByAdmin(link: string, note: string | null, actor: string, now = new Date()): Promise<{ title_no: number; created: boolean }> {
  const title_no = soopVodId(link);
  if (!title_no) throw new VodRequestError("SOOP VOD 링크(vod.sooplive.com/player/번호)나 VOD 번호를 넣어 주세요.");
  const r = await db().begin((tx) => requestVodInTx(tx, { title_no, reason: "admin", requested_by: actor, note }, now));
  return { title_no, ...r };
}

/** 운영자 요청 거두기 — 열린 운영자 요청만. 제보의 요청은 제보 판정이 거둔다(2단계 ④⑤). */
export async function cancelVodRequest(id: number, actor: string, now = new Date()): Promise<void> {
  const done = await db()`
    UPDATE vod_request SET state = 'cancelled', closed_at = ${now}, outcome_note = ${`거둠(${actor})`}
     WHERE id = ${id} AND submission_id IS NULL AND state IN ('queued', 'claimed')`;
  if (!done.count) throw new VodRequestError("열린 운영자 요청이 아닙니다. 새로고침해 주세요.");
}

/** 열린 요청을 VOD 로 묶은 것 — 이 PC 의 ck:queue plan 이 읽는다. */
export interface OpenVodRequest {
  title_no: number;
  channel_id: string | null;
  /** 묶인 줄 중 가장 큰 것. */
  priority: number;
  /** 하나라도 queued 면 queued(이 PC 가 아직 못 본 요청이 있다 — 끝난 조사면 다시 연다). */
  state: "queued" | "claimed";
  requested_at: Date;
  reasons: VodRequestReason[];
  submission_ids: string[];
  notes: string[];
}

export async function listOpenVodRequests(sql: Sql = db()): Promise<OpenVodRequest[]> {
  return sql<OpenVodRequest[]>`
    SELECT title_no::float8 AS title_no, max(channel_id) AS channel_id, max(priority)::int AS priority,
           CASE WHEN bool_or(state = 'queued') THEN 'queued' ELSE 'claimed' END AS state,
           min(requested_at) AS requested_at,
           array_agg(DISTINCT reason ORDER BY reason) AS reasons,
           COALESCE(array_agg(submission_id::text ORDER BY submission_id) FILTER (WHERE submission_id IS NOT NULL), '{}') AS submission_ids,
           COALESCE(array_agg(note ORDER BY requested_at, id) FILTER (WHERE note IS NOT NULL), '{}') AS notes
      FROM vod_request WHERE state IN ('queued', 'claimed')
     GROUP BY title_no ORDER BY max(priority) DESC, min(requested_at), title_no`;
}

/** 대기열에 넣었다 — 그 VOD 의 queued 를 claimed 로, 모르던 채널을 채운다. 바뀐 줄 수. */
export async function claimVodRequests(title_no: number, channel_id: string | null, now = new Date()): Promise<number> {
  const done = await db()`
    UPDATE vod_request SET state = 'claimed', claimed_at = ${now}, channel_id = COALESCE(channel_id, ${channel_id})
     WHERE title_no = ${title_no} AND state = 'queued'`;
  return done.count;
}

/**
 * 판독이 끝났다(done) · 영상이 없다(unavailable) — 그 VOD 의 열린 줄을 모두 닫고, 닫힌 줄이 가리키던 제보 번호를 돌려준다.
 * 트랜잭션 안에서만 — 제보 다시 판정과 한 트랜잭션이어야 해서 공개 함수는 submission.ts 의 settleVodRequests 다.
 */
export async function closeVodRequestsInTx(tx: Tx, title_no: number, state: Extract<VodRequestState, "done" | "unavailable">, note: string | null, now = new Date()): Promise<{ closed: number; submission_ids: string[] }> {
  const rows = await tx<{ submission_id: string | null }[]>`
    UPDATE vod_request SET state = ${state}, closed_at = ${now}, outcome_note = ${note ? note.slice(0, 500) : null},
           claimed_at = COALESCE(claimed_at, ${now})
     WHERE title_no = ${title_no} AND state IN ('queued', 'claimed') RETURNING submission_id`;
  return { closed: rows.length, submission_ids: [...new Set(rows.map((r) => r.submission_id).filter((x): x is string => !!x))] };
}

/** 제보가 판독 전에 닫혔다(반려·확인·중복) — 그 제보의 열린 요청을 거둔다. 같은 VOD 의 다른 요청은 그대로. */
export async function cancelSubmissionVodRequestsInTx(tx: Tx, submissionId: string, why: string, now = new Date()): Promise<number> {
  const done = await tx`
    UPDATE vod_request SET state = 'cancelled', closed_at = ${now}, outcome_note = ${why.slice(0, 500)}
     WHERE submission_id = ${submissionId}::uuid AND state IN ('queued', 'claimed')`;
  return done.count;
}

/** 제보의 요청 상태(같은 제보 × 같은 VOD 는 한 줄). 없으면 null. */
export async function submissionVodRequestInTx(sql: Sql, submissionId: string, title_no: number): Promise<VodRequestState | null> {
  const [r] = await sql<{ state: VodRequestState }[]>`SELECT state FROM vod_request WHERE submission_id = ${submissionId}::uuid AND title_no = ${title_no}`;
  return r?.state ?? null;
}

/**
 * 그 VOD 에서 판독이 기록한 경기 — 시점을 주면 그 앞뒤 30분 안의 근거 화면(match_evidence_frame)이 이은 경기만.
 * VOD 단서의 "찾았나"(사실 vod.found)와 운영 화면이 같이 쓴다.
 */
export const HINT_WINDOW_SEC = 1800;
export async function vodMatchesInTx(sql: Sql, title_no: number, range?: { from_sec?: number; to_sec?: number }): Promise<string[]> {
  const key = `vod:${title_no}`;
  const rows = range?.from_sec === undefined
    ? await sql<{ match_id: string }[]>`
        SELECT DISTINCT p.match_id FROM event_lead l JOIN match_pov p ON p.lead_id = l.id
         WHERE l.source = 'vod_title' AND l.source_key = ${key} ORDER BY p.match_id`
    : await sql<{ match_id: string }[]>`
        SELECT DISTINCT f.match_id FROM event_lead l JOIN match_evidence_frame f ON f.lead_id = l.id
         WHERE l.source = 'vod_title' AND l.source_key = ${key} AND f.match_id IS NOT NULL
           AND f.at_sec BETWEEN ${range.from_sec - HINT_WINDOW_SEC} AND ${(range.to_sec ?? range.from_sec) + HINT_WINDOW_SEC}
         ORDER BY f.match_id`;
  return rows.map((r) => r.match_id);
}

export interface AdminVodRequest {
  id: number; title_no: number; channel_id: string | null; priority: number; reason: VodRequestReason;
  submission_id: string | null; note: string | null; requested_by: string; state: VodRequestState;
  outcome_note: string | null; requested_at: Date; claimed_at: Date | null; closed_at: Date | null;
}

/** 운영 화면 — 열린 것 먼저, 그다음 최근에 닫힌 것. */
export async function listVodRequestsForAdmin(limit = 50): Promise<AdminVodRequest[]> {
  return db()<AdminVodRequest[]>`
    SELECT id::int AS id, title_no::float8 AS title_no, channel_id, priority, reason, submission_id, note, requested_by, state,
           outcome_note, requested_at, claimed_at, closed_at
      FROM vod_request
     ORDER BY (state IN ('queued', 'claimed')) DESC, COALESCE(closed_at, requested_at) DESC, id DESC
     LIMIT ${limit}`;
}
