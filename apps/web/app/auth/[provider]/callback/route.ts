import { NextResponse, type NextRequest } from "next/server";

import { finishLogin, isProvider, LOGIN_STATE_COOKIE, providerConfig } from "@soop-lol/core/lib/auth/oauth";
import { cookieSecure } from "@soop-lol/core/lib/auth/request";
import { SESSION_COOKIE } from "@soop-lol/core/lib/auth/session";
import { createSession, loginWithIdentity } from "@soop-lol/core/lib/db/member";
import { loginHref, meHref } from "@soop-lol/core/lib/site-paths";
import { kstDateString } from "@soop-lol/core/lib/time";

import { siteOrigin } from "@/lib/site-origin";

/**
 * 소셜 로그인 콜백. docs/COMMUNITY-PLAN.md §2 "로그인"
 *
 * ★ 로그인 상태 쿠키는 결과와 상관없이 지운다 — 같은 콜백을 다시 보내면(재사용) 상태가 없어 거부된다.
 * ★ 토큰 요청의 redirect_uri 는 콜백 주소에서 만들어진다. 요청 주소를 그대로 쓰지 않고 사이트 주소 기준으로 다시 만든다.
 * ★ 실패 사유는 화면에 자세히 내지 않는다(로그에만). 화면은 "다시 시도" 만 안내한다.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const origin = siteOrigin(request);
  const finish = (path: string, session?: { token: string; expiresAt: Date }) => {
    const response = NextResponse.redirect(new URL(path, origin));
    response.cookies.set(LOGIN_STATE_COOKIE, "", { httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/auth", maxAge: 0 });
    if (session) {
      response.cookies.set(SESSION_COOKIE, session.token, {
        httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/", expires: session.expiresAt,
      });
    }
    return response;
  };
  const fail = (code: string) => {
    const url = new URL(loginHref(), origin);
    url.searchParams.set("error", code);
    return finish(`${url.pathname}${url.search}`);
  };

  if (!isProvider(provider)) return fail("provider");
  // 사용자가 제공자 화면에서 취소하면 error 를 달고 돌아온다.
  if (request.nextUrl.searchParams.has("error")) return fail("cancel");
  try {
    const config = await providerConfig(provider);
    const currentUrl = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, origin);
    const { subject, next } = await finishLogin(config, provider, request.cookies.get(LOGIN_STATE_COOKIE)?.value, currentUrl);
    const result = await loginWithIdentity(provider, subject);
    if (result.kind === "blocked") {
      const url = new URL(loginHref(), origin);
      url.searchParams.set("blocked", kstDateString(result.until));
      return finish(`${url.pathname}${url.search}`);
    }
    const session = await createSession(result.memberId);
    return finish(result.needsNickname ? meHref({ setup: 1, next }) : next, session);
  } catch (error) {
    console.error(`[auth] ${provider} 로그인 콜백 실패:`, error instanceof Error ? error.message : error);
    return fail("failed");
  }
}
