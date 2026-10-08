/**
 * 커뮤니티 — 관리자 쓰기·읽기와 정기 작업(파기). docs/COMMUNITY-PLAN.md §3 "신고·운영"·"삭제와 파기"
 *
 * ★ 쿠키를 보지 않는다 — 관리자 화면 액션이 requireAdmin 뒤에 부른다(편성표 관리자와 같다). 계약으로 열지 않는다.
 * ★ 운영 조치는 전부 community_moderation_log 에 사유와 함께 남긴다(본문은 남기지 않는다 — 파기 규칙).
 *   임시조치는 숨김의 한 종류다(기록의 action 이 'blind'). 30일 검토·파기 보류는 이 기록에서 계산한다.
 * ★ 잠금 순서는 회원 → 글 → 댓글. 운영 조치·파기는 대상 행을 잠근 뒤 상태를 다시 본다.
 */

import type postgres from "postgres";

import {
  daysAgo, moderationTransition, MODERATION_HOLD_DAYS, normalizePostInput, PURGE_AFTER_DAYS, REVIEW_AFTER_DAYS, SNAPSHOT_KEEP_DAYS,
  URGENT_REPORT_REASONS, validatePostInput,
  type CommunityGame, type ContentStatus, type ModerationAction, type ReportReason,
} from "../metrics/community.ts";
import { db } from "./client.ts";
import { CommunityError, lockComment, lockPost, postIdOfComment } from "./community.ts";
import { cleanupExpiredSessions, cleanupWithdrawnIdentities, lockMember, sanctionsOf } from "./member.ts";

type Tx = postgres.TransactionSql;
type Kind = "post" | "comment";

const DAY_MS = 86_400_000;

// ── 운영 조치 ────────────────────────────────────────────────────────

/**
 * 유지·숨김·임시조치·삭제·해제. 대상 행을 잠그고 상태 전이(metrics moderationTransition)를 따른다.
 * 그 대상의 열린 신고는 같은 트랜잭션에서 닫는다(유지 → 기각, 그 밖 → 조치). 해제는 신고를 건드리지 않는다.
 */
export async function moderateContent(kind: Kind, targetId: number, action: ModerationAction, reason: string, actor: string, now = new Date()): Promise<void> {
  if (!reason.trim()) throw new CommunityError("처리 사유를 적어 주세요.");
  const postId = kind === "post" ? targetId : await postIdOfComment(db(), targetId);
  if (postId === null) throw new CommunityError("없는 댓글입니다.");
  await db().begin(async (tx) => {
    let status: ContentStatus;
    if (kind === "post") {
      const post = await lockPost(tx, targetId, "update");
      if (!post) throw new CommunityError("없는 글입니다.");
      status = post.status;
    } else {
      await lockPost(tx, postId, "share");
      const comment = await lockComment(tx, targetId, "update");
      if (!comment) throw new CommunityError("없는 댓글입니다.");
      status = comment.status;
    }
    const step = moderationTransition(status, action);
    if ("error" in step) throw new CommunityError(step.error);
    if (step.next !== status) {
      const deletedAt = step.next === "deleted" ? now : null;
      if (kind === "post") {
        await tx`UPDATE community_post SET status = ${step.next}, deleted_at = ${deletedAt}, updated_at = ${now} WHERE id = ${targetId}`;
      } else {
        await tx`UPDATE community_comment SET status = ${step.next}, deleted_at = ${deletedAt}, updated_at = ${now} WHERE id = ${targetId}`;
      }
    }
    await tx`INSERT INTO community_moderation_log (kind, target_id, action, reason, actor, created_at)
             VALUES (${kind}, ${targetId}, ${action}, ${reason.trim()}, ${actor}, ${now})`;
    if (action !== "restore") {
      await tx`UPDATE community_report SET status = ${action === "keep" ? "dismissed" : "actioned"}, handled_at = ${now}
               WHERE kind = ${kind} AND target_id = ${targetId} AND status = 'open'`;
    }
  });
}

/** 공지 — 작성자는 "운영자"(author_id NULL). 회원 경로로는 못 쓴다. */
export async function createNotice(input: { game_code: CommunityGame | null; title: string; body: string }, now = new Date()): Promise<{ id: number }> {
  const normalized = normalizePostInput({ ...input, topic: "notice", streamer_ids: [] });
  const errors = validatePostInput(normalized, { allowNotice: true });
  if (errors.length) throw new CommunityError(errors.join(" "));
  const [row] = await db()<{ id: number }[]>`
    INSERT INTO community_post (author_id, game_code, topic, title, body, created_at, updated_at)
    VALUES (NULL, ${normalized.game_code}, 'notice', ${normalized.title}, ${normalized.body}, ${now}, ${now}) RETURNING id::int AS id`;
  return row;
}

// ── 제재 ─────────────────────────────────────────────────────────────

/** 쓰기 제한. days = null 이면 영구. 회원 행을 잠근다 — 탈퇴·연결 정리와 같은 잠금이라 재가입 기간 계산이 어긋나지 않는다. */
export async function addSanction(memberId: string, days: number | null, reason: string, actor: string, now = new Date()): Promise<void> {
  if (!reason.trim()) throw new CommunityError("제재 사유를 적어 주세요.");
  if (days !== null && !(Number.isInteger(days) && days > 0)) throw new CommunityError("제재 기간을 확인해 주세요.");
  await db().begin(async (tx) => {
    await lockMember(tx, memberId);
    const endsAt = days === null ? null : new Date(now.getTime() + days * DAY_MS);
    await tx`INSERT INTO community_sanction (member_id, ends_at, reason, actor, created_at)
             VALUES (${memberId}::uuid, ${endsAt}, ${reason.trim()}, ${actor}, ${now})`;
  });
}

export async function liftSanction(sanctionId: number, now = new Date()): Promise<void> {
  const [row] = await db()<{ member_id: string }[]>`SELECT member_id FROM community_sanction WHERE id = ${sanctionId}`;
  if (!row) throw new CommunityError("없는 제재입니다.");
  await db().begin(async (tx) => {
    await lockMember(tx, row.member_id);
    await tx`UPDATE community_sanction SET lifted_at = ${now} WHERE id = ${sanctionId} AND lifted_at IS NULL`;
  });
}

// ── 관리자 읽기 ──────────────────────────────────────────────────────

export interface ReportEntry {
  report_id: number;
  reason: ReportReason;
  detail: string | null;
  snapshot_title: string | null;
  snapshot_body: string | null;
  created_at: Date;
}

export interface ReportQueueItem {
  kind: Kind;
  target_id: number;
  post_id: number;
  /** 지금 상태와 내용(신고 당시 내용은 reports 의 snapshot) */
  status: ContentStatus;
  title: string | null;
  body: string | null;
  edited_at: Date | null;
  author_id: string | null;
  author_nickname: string | null;
  urgent: boolean;
  reports: ReportEntry[];
  /** 첫 신고 뒤에 작성자가 고쳤나 */
  edited_after_report: boolean;
}

/** 열린 신고를 대상별로 묶는다. 개인정보 노출·명예훼손이 먼저, 그다음 신고 수, 오래된 순. */
export async function listReportQueue(): Promise<ReportQueueItem[]> {
  const rows = await db()<(ReportEntry & { kind: Kind; target_id: number })[]>`
    SELECT id::int AS report_id, kind, target_id::int AS target_id, reason, detail, snapshot_title, snapshot_body, created_at
      FROM community_report WHERE status = 'open' ORDER BY created_at`;
  const groups = new Map<string, ReportQueueItem>();
  for (const r of rows) {
    const key = `${r.kind}:${r.target_id}`;
    let item = groups.get(key);
    if (!item) {
      const [target] = r.kind === "post"
        ? await db()<Omit<ReportQueueItem, "kind" | "target_id" | "urgent" | "reports" | "edited_after_report">[]>`
            SELECT p.id::int AS post_id, p.status, p.title, p.body, p.edited_at, p.author_id, m.nickname AS author_nickname
              FROM community_post p LEFT JOIN member m ON m.id = p.author_id WHERE p.id = ${r.target_id}`
        : await db()<Omit<ReportQueueItem, "kind" | "target_id" | "urgent" | "reports" | "edited_after_report">[]>`
            SELECT c.post_id::int AS post_id, c.status, NULL::text AS title, c.body, c.edited_at, c.author_id, m.nickname AS author_nickname
              FROM community_comment c LEFT JOIN member m ON m.id = c.author_id WHERE c.id = ${r.target_id}`;
      if (!target) continue;
      item = { ...target, kind: r.kind, target_id: r.target_id, urgent: false, reports: [], edited_after_report: false };
      groups.set(key, item);
    }
    item.reports.push({ report_id: r.report_id, reason: r.reason, detail: r.detail, snapshot_title: r.snapshot_title, snapshot_body: r.snapshot_body, created_at: r.created_at });
    if (URGENT_REPORT_REASONS.includes(r.reason)) item.urgent = true;
  }
  const items = [...groups.values()];
  for (const item of items) item.edited_after_report = !!item.edited_at && item.edited_at > item.reports[0].created_at;
  return items.sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.reports.length - a.reports.length
    || a.reports[0].created_at.getTime() - b.reports[0].created_at.getTime());
}

export interface ReviewItem {
  kind: Kind;
  target_id: number;
  post_id: number;
  /** 'blind' 면 임시조치 — 다시 볼 것, 'hide' 면 숨김 — 확정할 것(삭제 또는 해제) */
  action: "hide" | "blind";
  reason: string;
  since: Date;
  title: string | null;
}

/** 숨김·임시조치가 30일 넘게 그대로인 대상. 자동으로 되살리지 않고 사람이 다시 본다. 기록에서 계산한다. */
export async function listReviewQueue(now = new Date()): Promise<ReviewItem[]> {
  return db()<ReviewItem[]>`
    WITH latest AS (
      SELECT DISTINCT ON (kind, target_id) kind, target_id, action, reason, created_at
        FROM community_moderation_log ORDER BY kind, target_id, created_at DESC, id DESC
    )
    SELECT l.kind, l.target_id::int AS target_id, COALESCE(p.id, c.post_id)::int AS post_id, l.action, l.reason, l.created_at AS since,
           CASE WHEN l.kind = 'post' THEN p.title END AS title
      FROM latest l
      LEFT JOIN community_post p ON l.kind = 'post' AND p.id = l.target_id
      LEFT JOIN community_comment c ON l.kind = 'comment' AND c.id = l.target_id
     WHERE l.action IN ('hide', 'blind') AND COALESCE(p.status, c.status) = 'hidden'
       AND l.created_at < ${daysAgo(now, REVIEW_AFTER_DAYS)}
     ORDER BY l.created_at`;
}

export interface ModerationLogRow { kind: Kind; target_id: number; action: ModerationAction; reason: string; actor: string; created_at: Date }

export async function listRecentModeration(limit = 30): Promise<ModerationLogRow[]> {
  return db()<ModerationLogRow[]>`
    SELECT kind, target_id::int AS target_id, action, reason, actor, created_at FROM community_moderation_log
     ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
}

export interface AdminMemberView {
  member_id: string;
  nickname: string | null;
  status: "active" | "withdrawn";
  created_at: Date;
  sanctions: { id: number; reason: string; created_at: Date; ends_at: Date | null; lifted_at: Date | null }[];
}

export async function getMemberForAdmin(memberId: string): Promise<AdminMemberView | null> {
  const [m] = await db()<Omit<AdminMemberView, "sanctions">[]>`
    SELECT id AS member_id, nickname, status, created_at FROM member WHERE id = ${memberId}::uuid`;
  if (!m) return null;
  return { ...m, sanctions: await sanctionsOf(db(), memberId) };
}

// ── 정기 작업 — 파기 ─────────────────────────────────────────────────

/** 대상(글이면 그 댓글까지)에 열린 신고나 최근 운영 조치가 있으면 파기를 미룬다 — 분쟁 중 원문이 사라지면 판단할 근거가 없다. */
async function purgeHeld(tx: Tx, kind: Kind, targetId: number, now: Date): Promise<boolean> {
  const since = daysAgo(now, MODERATION_HOLD_DAYS);
  const [row] = kind === "post"
    ? await tx<{ held: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM community_report r WHERE r.status = 'open' AND (
                 (r.kind = 'post' AND r.target_id = ${targetId})
                 OR (r.kind = 'comment' AND r.target_id IN (SELECT id FROM community_comment WHERE post_id = ${targetId}))))
            OR EXISTS (SELECT 1 FROM community_moderation_log l WHERE l.created_at > ${since} AND (
                 (l.kind = 'post' AND l.target_id = ${targetId})
                 OR (l.kind = 'comment' AND l.target_id IN (SELECT id FROM community_comment WHERE post_id = ${targetId})))) AS held`
    : await tx<{ held: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM community_report WHERE status = 'open' AND kind = 'comment' AND target_id = ${targetId})
            OR EXISTS (SELECT 1 FROM community_moderation_log WHERE kind = 'comment' AND target_id = ${targetId} AND created_at > ${since}) AS held`;
  return row.held;
}

/**
 * 삭제 30일이 지난 글·댓글 파기. 제목·본문을 비우고 태그·추천을 지운다. **글을 파기하면 그 댓글도 함께** 파기한다.
 * 행의 뼈대는 남긴다(대댓글 자리·신고 기록이 가리키는 대상). 대상 행을 잠근 뒤 다시 확인한다 — 신고 접수와 겹치면 신고가 이긴다.
 */
export async function purgeDeletedContent(now = new Date()): Promise<{ posts: number; comments: number; held: number }> {
  const cutoff = daysAgo(now, PURGE_AFTER_DAYS);
  let posts = 0, comments = 0, held = 0;
  const duePosts = await db()<{ id: number }[]>`
    SELECT id::int AS id FROM community_post WHERE status = 'deleted' AND body IS NOT NULL AND deleted_at < ${cutoff} ORDER BY deleted_at`;
  for (const { id } of duePosts) {
    const outcome = await db().begin(async (tx) => {
      const post = await lockPost(tx, id, "update");
      if (!post || post.status !== "deleted" || post.body === null) return "skip" as const;
      const [still] = await tx`SELECT 1 FROM community_post WHERE id = ${id} AND deleted_at < ${cutoff}`;
      if (!still) return "skip" as const;
      if (await purgeHeld(tx, "post", id, now)) return "held" as const;
      await tx`UPDATE community_post SET title = NULL, body = NULL WHERE id = ${id}`;
      await tx`DELETE FROM community_post_streamer WHERE post_id = ${id}`;
      await tx`DELETE FROM community_post_vote WHERE post_id = ${id}`;
      await tx`UPDATE community_comment SET status = 'deleted', deleted_at = COALESCE(deleted_at, ${now}), body = NULL, updated_at = ${now}
               WHERE post_id = ${id} AND body IS NOT NULL`;
      await tx`UPDATE community_report SET snapshot_title = NULL, snapshot_body = NULL
               WHERE status <> 'open' AND ((kind = 'post' AND target_id = ${id})
                  OR (kind = 'comment' AND target_id IN (SELECT id FROM community_comment WHERE post_id = ${id})))`;
      return "purged" as const;
    });
    if (outcome === "purged") posts++;
    if (outcome === "held") held++;
  }
  const dueComments = await db()<{ id: number; post_id: number }[]>`
    SELECT c.id::int AS id, c.post_id::int AS post_id FROM community_comment c
     WHERE c.status = 'deleted' AND c.body IS NOT NULL AND c.deleted_at < ${cutoff} ORDER BY c.deleted_at`;
  for (const c of dueComments) {
    const outcome = await db().begin(async (tx) => {
      await lockPost(tx, c.post_id, "share");
      const comment = await lockComment(tx, c.id, "update");
      if (!comment || comment.status !== "deleted" || comment.body === null) return "skip" as const;
      if (await purgeHeld(tx, "comment", c.id, now)) return "held" as const;
      await tx`UPDATE community_comment SET body = NULL, updated_at = ${now} WHERE id = ${c.id}`;
      await tx`UPDATE community_report SET snapshot_title = NULL, snapshot_body = NULL
               WHERE status <> 'open' AND kind = 'comment' AND target_id = ${c.id}`;
      return "purged" as const;
    });
    if (outcome === "purged") comments++;
    if (outcome === "held") held++;
  }
  return { posts, comments, held };
}

/** 처리하고 30일이 지난 신고의 당시 내용을 비운다. */
export async function clearHandledSnapshots(now = new Date()): Promise<number> {
  const cleared = await db()`
    UPDATE community_report SET snapshot_title = NULL, snapshot_body = NULL
     WHERE status <> 'open' AND handled_at < ${daysAgo(now, SNAPSHOT_KEEP_DAYS)}
       AND (snapshot_title IS NOT NULL OR snapshot_body IS NOT NULL)`;
  return cleared.count;
}

/** 하루 한 번(worker -- community-housekeep). 파기 · 신고 당시 내용 · 탈퇴 회원 로그인 연결 · 만료 세션. */
export async function runCommunityHousekeep(now = new Date()) {
  const purged = await purgeDeletedContent(now);
  const snapshots = await clearHandledSnapshots(now);
  const identities = await cleanupWithdrawnIdentities(now);
  const sessions = await cleanupExpiredSessions(now);
  return { ...purged, snapshots, identities, sessions };
}
