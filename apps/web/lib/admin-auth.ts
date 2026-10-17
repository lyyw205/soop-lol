import { basicAdminMode, isOwnerMember } from "@soop-lol/core/lib/auth/owner";
export { basicAdminMode, isOwnerMember } from "@soop-lol/core/lib/auth/owner";
import { memberFromSession } from "@soop-lol/core/lib/db/member";
import { SESSION_COOKIE } from "@soop-lol/core/lib/auth/session";

/** 관리자 입구·API·서버 액션은 같은 검사를 사용한다. 기본은 회원 세션 방식이다.
 * Basic은 기존 도구/격리 테스트에서 ADMIN_AUTH_MODE=basic을 명시할 때만 허용한다.
 * 회원 방식에서 실패해도 Basic으로 우회하지 않는다. */
export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; message: string };

/** 길이·내용 노출을 줄이는 상수시간 비교. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `Authorization` 헤더 하나로 판정한다. next 의존이 없어 proxy·액션이 같이 쓴다. */
export function checkBasicAuth(header: string | null | undefined): AdminAuthResult {
  const expectedUser = process.env.ADMIN_USER ?? "admin";
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedPassword) {
    return { ok: false, status: 503, message: "ADMIN_PASSWORD 가 설정되지 않아 관리자 화면을 잠갔습니다. .env.local 을 확인하세요." };
  }
  if (!header?.startsWith("Basic ")) return { ok: false, status: 401, message: "인증이 필요합니다." };

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return { ok: false, status: 401, message: "인증 형식이 올바르지 않습니다." };
  }
  const separator = decoded.indexOf(":");
  const user = separator === -1 ? decoded : decoded.slice(0, separator);
  const password = separator === -1 ? "" : decoded.slice(separator + 1);
  if (!safeEqual(user, expectedUser) || !safeEqual(password, expectedPassword)) {
    return { ok: false, status: 401, message: "아이디 또는 비밀번호가 틀렸습니다." };
  }
  return { ok: true };
}

export type AdminIdentity = { actor: string; memberId: string | null };
export type AdminAccess = { ok: true; identity: AdminIdentity } | Exclude<AdminAuthResult, { ok: true }>;

export async function checkAdminAuth(token: string | null | undefined, authorization?: string | null): Promise<AdminAccess> {
  if (basicAdminMode()) {
    const result = checkBasicAuth(authorization);
    return result.ok ? { ok: true, identity: { actor: process.env.ADMIN_USER ?? "admin", memberId: null } } : result;
  }
  if (!process.env.SUPER_ADMIN_MEMBER_ID) return { ok: false, status: 503, message: "관리자 계정이 설정되지 않았습니다." };
  const member = await memberFromSession(token);
  if (!member) return { ok: false, status: 401, message: "로그인이 필요합니다." };
  if (!isOwnerMember(member)) return { ok: false, status: 403, message: "관리자 권한이 없습니다." };
  return { ok: true, identity: { actor: `member:${member.member_id}`, memberId: member.member_id } };
}

/** 서버 액션·서버 컴포넌트·Route Handler에서만 호출한다. */
export async function currentAdminAccess(): Promise<AdminAccess> {
  const { cookies, headers } = await import("next/headers");
  return checkAdminAuth((await cookies()).get(SESSION_COOKIE)?.value, (await headers()).get("authorization"));
}

/** 모든 저장 액션은 브라우저/폼의 회원 ID를 믿지 않고 현재 세션을 다시 검증한다. */
export async function requireAdmin(): Promise<AdminIdentity> {
  const result = await currentAdminAccess();
  if (!result.ok) throw new Error(`관리자 인증 실패: ${result.message}`);
  return result.identity;
}
