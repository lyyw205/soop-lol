/**
 * 회원 — 로그인·세션·닉네임·탈퇴. docs/COMMUNITY-PLAN.md §2
 *
 * ★ Next 를 모른다. 세션은 **토큰을 인자로** 받는다 — 쿠키를 읽는 곳은 core/lib/auth/request.ts 하나다.
 *   그래서 verify:db 가 실제로 발급한 토큰으로 같은 함수를 부른다(검사를 건너뛰는 시험용 함수가 없다).
 * ★ 잠금 규칙(§3 쓰기) — 회원 쓰기·탈퇴·제재 변경·로그인 연결 정리는 모두 member 행을 FOR UPDATE 로 먼저 잠근다.
 *   순서는 언제나 회원 → 글 → 댓글. 잠근 뒤 세션·상태·제재를 **다시** 확인한다 — 기다리는 사이 탈퇴·제재가 끝났을 수 있다.
 * ★ 재가입 제한 기간은 저장하지 않는다 — 탈퇴 시각과 제재 기록에서 metrics/community.ts 가 그때그때 계산한다.
 */

import type postgres from "postgres";

import type { Provider } from "../auth/oauth.ts";
import { hashSessionToken, newSessionToken, SESSION_DAYS } from "../auth/session.ts";
import { activeSanction, rejoinBlockedUntil, type SanctionPeriod } from "../metrics/community.ts";
import { checkNickname, nicknameKey } from "../metrics/nickname.ts";
import { kstDateString } from "../time.ts";
import { db } from "./client.ts";

type Tx = postgres.TransactionSql;
type Sql = postgres.Sql | Tx;

const DAY_MS = 86_400_000;

/** 회원 쓰기 거부. message 를 그대로 화면에 보여준다. */
export class MemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberError";
  }
}

export const LOGIN_REQUIRED_MESSAGE = "로그인이 필요합니다.";

/** 화면이 쓰는 지금 회원. 닉네임이 없으면 아직 가입을 마치지 않았다. */
export interface SessionMember {
  member_id: string;
  nickname: string | null;
  created_at: Date;
}

export interface LockedMember {
  id: string;
  status: "active" | "withdrawn";
  nickname: string | null;
  created_at: Date;
  withdrawn_at: Date | null;
}

interface SanctionRow extends SanctionPeriod {
  id: number;
  reason: string;
}

export async function sanctionsOf(sql: Sql, memberId: string): Promise<SanctionRow[]> {
  return sql<SanctionRow[]>`
    SELECT id, reason, created_at, ends_at, lifted_at FROM community_sanction WHERE member_id = ${memberId}::uuid ORDER BY created_at`;
}

/** 회원 행 잠금. 잠금 순서의 첫 칸이다. */
export async function lockMember(tx: Tx, memberId: string): Promise<LockedMember> {
  const [m] = await tx<LockedMember[]>`
    SELECT id, status, nickname, created_at, withdrawn_at FROM member WHERE id = ${memberId}::uuid FOR UPDATE`;
  if (!m) throw new MemberError(LOGIN_REQUIRED_MESSAGE);
  return m;
}

/**
 * 회원 쓰기의 문. 토큰 → 회원 찾기 → **회원 행 잠금** → 잠근 뒤 세션·상태·(선택) 닉네임·제재를 다시 확인한다.
 * 기다리는 동안 탈퇴가 끝났으면 세션이 지워져 있어 여기서 거부된다.
 */
export async function lockSessionMember(
  tx: Tx, token: string | null | undefined, now: Date,
  opts: { needNickname?: boolean; checkSanction?: boolean } = {},
): Promise<LockedMember> {
  if (!token) throw new MemberError(LOGIN_REQUIRED_MESSAGE);
  const hash = hashSessionToken(token);
  const [s] = await tx<{ member_id: string }[]>`
    SELECT member_id FROM member_session WHERE token_hash = ${hash} AND expires_at > ${now}`;
  if (!s) throw new MemberError(LOGIN_REQUIRED_MESSAGE);
  const m = await lockMember(tx, s.member_id);
  const [still] = await tx`SELECT 1 FROM member_session WHERE token_hash = ${hash} AND expires_at > ${now}`;
  if (!still || m.status !== "active") throw new MemberError(LOGIN_REQUIRED_MESSAGE);
  if (opts.needNickname && m.nickname === null) throw new MemberError("닉네임을 먼저 정해 주세요.");
  if (opts.checkSanction) {
    const active = activeSanction(await sanctionsOf(tx, m.id), now);
    if (active) {
      throw new MemberError(active.ends_at
        ? `${kstDateString(active.ends_at)}까지 글을 쓸 수 없습니다. (사유: ${active.reason})`
        : `글을 쓸 수 없는 계정입니다. (사유: ${active.reason})`);
    }
  }
  return m;
}

// ── 로그인 ───────────────────────────────────────────────────────────

export type LoginResult =
  | { kind: "ok"; memberId: string; needsNickname: boolean }
  | { kind: "blocked"; until: Date };

/**
 * 제공자가 확인한 사람(provider, subject)을 회원으로 정한다. 처음이면 새 회원을 만든다.
 *
 * ★ 탈퇴 회원의 연결이면 회원 행을 잠근 뒤 재가입 제한 기간을 **다시 계산**한다. 기간 안이면 막고,
 *   기간이 끝났으면 그 자리에서 옛 연결을 지우고 새로 가입한다(정기 작업을 기다리지 않는다).
 * ★ 같은 사람이 동시에 처음 로그인하면 한쪽은 PK 충돌로 실패한다 — 다시 시도하면 된다(드문 경우라 재시도 장치를 두지 않는다).
 */
export async function loginWithIdentity(provider: Provider, subject: string, now = new Date()): Promise<LoginResult> {
  return db().begin(async (tx) => {
    const [found] = await tx<{ member_id: string }[]>`
      SELECT member_id FROM member_identity WHERE provider = ${provider} AND subject = ${subject}`;
    if (found) {
      const m = await lockMember(tx, found.member_id);
      if (m.status === "active") {
        await tx`UPDATE member_identity SET last_login_at = ${now} WHERE provider = ${provider} AND subject = ${subject}`;
        return { kind: "ok", memberId: m.id, needsNickname: m.nickname === null };
      }
      const until = rejoinBlockedUntil(m.withdrawn_at!, await sanctionsOf(tx, m.id));
      if (now < until) return { kind: "blocked", until };
      await tx`DELETE FROM member_identity WHERE member_id = ${m.id}::uuid`;
    }
    const [created] = await tx<{ id: string }[]>`INSERT INTO member (created_at) VALUES (${now}) RETURNING id`;
    await tx`INSERT INTO member_identity (provider, subject, member_id, created_at, last_login_at)
             VALUES (${provider}, ${subject}, ${created.id}::uuid, ${now}, ${now})`;
    return { kind: "ok", memberId: created.id, needsNickname: true };
  });
}

// ── 세션 ─────────────────────────────────────────────────────────────

export async function createSession(memberId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS);
  await db()`INSERT INTO member_session (token_hash, member_id, created_at, expires_at)
             VALUES (${hashSessionToken(token)}, ${memberId}::uuid, ${now}, ${expiresAt})`;
  return { token, expiresAt };
}

/** 토큰의 회원. 만료·로그아웃·탈퇴면 null. 읽기만 한다(렌더 중에 쓰지 않는다). */
export async function memberFromSession(token: string | null | undefined, now = new Date()): Promise<SessionMember | null> {
  if (!token) return null;
  const [row] = await db()<SessionMember[]>`
    SELECT m.id AS member_id, m.nickname, m.created_at
      FROM member_session s JOIN member m ON m.id = s.member_id
     WHERE s.token_hash = ${hashSessionToken(token)} AND s.expires_at > ${now} AND m.status = 'active'`;
  return row ?? null;
}

export async function deleteSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await db()`DELETE FROM member_session WHERE token_hash = ${hashSessionToken(token)}`;
}

// ── 닉네임 ───────────────────────────────────────────────────────────

/** 사칭 판정용 — 등록 스트리머(숨긴 사람 포함)의 이름·별칭 정규화 키. */
export async function streamerNameKeys(sql: Sql = db()): Promise<Set<string>> {
  const rows = await sql<{ display_name: string; aliases: string[] }[]>`SELECT display_name, aliases FROM streamer`;
  const keys = new Set<string>();
  for (const r of rows) for (const name of [r.display_name, ...r.aliases]) {
    const key = nicknameKey(name);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * 닉네임 정하기·바꾸기. 처음 정할 때는 약관·처리방침 동의(만 14세 이상 확인 포함)를 같이 받는다.
 */
export async function setNickname(token: string | null | undefined, raw: string, opts: { agreed?: boolean } = {}, now = new Date()): Promise<{ nickname: string }> {
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now);
    if (m.nickname === null && !opts.agreed) {
      throw new MemberError("이용약관·개인정보처리방침에 동의하고 만 14세 이상인지 확인해 주세요.");
    }
    const checked = checkNickname(raw, await streamerNameKeys(tx));
    if (!checked.ok) throw new MemberError(checked.error);
    if (m.nickname === checked.nickname) return { nickname: checked.nickname };
    const [taken] = await tx`SELECT 1 FROM member WHERE nickname_key = ${checked.key} AND id <> ${m.id}::uuid`;
    if (taken) throw new MemberError("이미 쓰는 닉네임입니다.");
    // UNIQUE(nickname_key) 가 마지막 문이다 — 동시에 같은 닉네임을 정하면 한쪽이 여기서 실패한다.
    try {
      await tx`UPDATE member SET nickname = ${checked.nickname}, nickname_key = ${checked.key}, agreed_at = COALESCE(agreed_at, ${now})
               WHERE id = ${m.id}::uuid`;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new MemberError("이미 쓰는 닉네임입니다.");
      throw error;
    }
    return { nickname: checked.nickname };
  });
}

// ── 탈퇴 ─────────────────────────────────────────────────────────────

/**
 * 탈퇴. 회원 행은 남기고(작성자 키) 닉네임을 지운다. 로그인 연결은 재가입 제한 기간이 끝날 때까지 남는다.
 * deleteContent 면 같은 트랜잭션에서 내 글·댓글을 삭제한다(30일 뒤 파기). 잠금 순서: 회원 → 글 → 댓글.
 */
export async function withdrawMember(token: string | null | undefined, opts: { deleteContent: boolean }, now = new Date()): Promise<void> {
  await db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now);
    if (opts.deleteContent) {
      await tx`UPDATE community_post SET status = 'deleted', deleted_at = ${now}, updated_at = ${now}
               WHERE author_id = ${m.id}::uuid AND status <> 'deleted'`;
      await tx`UPDATE community_comment SET status = 'deleted', deleted_at = ${now}, updated_at = ${now}
               WHERE author_id = ${m.id}::uuid AND status <> 'deleted'`;
    }
    await tx`DELETE FROM member_session WHERE member_id = ${m.id}::uuid`;
    await tx`UPDATE member SET status = 'withdrawn', withdrawn_at = ${now}, nickname = NULL, nickname_key = NULL
             WHERE id = ${m.id}::uuid`;
  });
}

// ── 정리(정기 작업) ───────────────────────────────────────────────────

/**
 * 재가입 제한 기간이 끝난 탈퇴 회원의 로그인 연결을 지운다. 회원마다 행을 잠근 뒤 **다시 계산**한다 —
 * 목록을 읽은 직후 들어온 제재를 놓치지 않게.
 */
export async function cleanupWithdrawnIdentities(now = new Date()): Promise<number> {
  const rows = await db()<{ member_id: string }[]>`
    SELECT DISTINCT i.member_id FROM member_identity i JOIN member m ON m.id = i.member_id WHERE m.status = 'withdrawn'`;
  let removed = 0;
  for (const r of rows) {
    removed += await db().begin(async (tx) => {
      const m = await lockMember(tx, r.member_id);
      if (m.status !== "withdrawn" || !m.withdrawn_at) return 0;
      if (now < rejoinBlockedUntil(m.withdrawn_at, await sanctionsOf(tx, m.id))) return 0;
      const deleted = await tx`DELETE FROM member_identity WHERE member_id = ${m.id}::uuid`;
      return deleted.count;
    });
  }
  return removed;
}

/** 만료된 세션 행 지우기. */
export async function cleanupExpiredSessions(now = new Date()): Promise<number> {
  const deleted = await db()`DELETE FROM member_session WHERE expires_at <= ${now}`;
  return deleted.count;
}
