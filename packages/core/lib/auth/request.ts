/**
 * 요청에서 회원 신원을 읽는 **유일한 곳** — 쿠키는 여기서만 읽고 쓴다.
 *
 * ★ core 에서 next 에 기대는 곳은 이 파일 하나다. 워커·검증 스크립트는 import 하지 않는다
 *   (Next 요청 밖에서 cookies() 를 부르면 오류다). DB 접근자는 토큰을 인자로 받는다 — 판단은 거기서 한다.
 * ★ 나중에 앱이 붙으면 요청 헤더에서 같은 세션 토큰을 읽는 함수를 여기 옆에 둔다. 접근자는 그대로다.
 */

import { cookies } from "next/headers";

import { memberFromSession, type SessionMember } from "../db/member.ts";
import { SESSION_COOKIE } from "./session.ts";

/** 운영(https)에서만 Secure. 로컬 http 개발 서버에서도 로그인이 되게. */
export const cookieSecure = (): boolean => process.env.NODE_ENV === "production";

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** 지금 회원(화면용). 로그인 안 했거나 세션이 끝났으면 null. */
export async function currentMember(): Promise<SessionMember | null> {
  return memberFromSession(await readSessionToken());
}

/** 서버 액션·라우트 핸들러에서만 부른다(렌더 중에는 쿠키를 쓸 수 없다). */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/", expires: expiresAt });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", { httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/", maxAge: 0 });
}
