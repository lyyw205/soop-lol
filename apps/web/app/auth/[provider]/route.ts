import { NextResponse, type NextRequest } from "next/server";

import {
  enabledProviders, encodeLoginState, isProvider, LOGIN_STATE_COOKIE, LOGIN_STATE_TTL_MS, providerConfig, startLogin,
} from "@soop-lol/core/lib/auth/oauth";
import { cookieSecure } from "@soop-lol/core/lib/auth/request";
import { loginCallbackPath, loginHref } from "@soop-lol/core/lib/site-paths";

import { siteOrigin } from "@/lib/site-origin";

/**
 * 소셜 로그인 시작 — 제공자의 인가 화면으로 보낸다. docs/COMMUNITY-PLAN.md §2 "로그인"
 * state·nonce·PKCE 검증값은 제공자 이름과 함께 짧게 사는 httpOnly 쿠키에 담는다(콜백 경로에만 보낸다).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const origin = siteOrigin(request);
  const back = (error?: string) => {
    const url = new URL(loginHref(request.nextUrl.searchParams.get("next") ?? undefined), origin);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url);
  };
  if (!isProvider(provider) || !enabledProviders().includes(provider)) return back("provider");
  try {
    const config = await providerConfig(provider);
    const redirectUri = new URL(loginCallbackPath(provider), origin).toString();
    const { url, state } = await startLogin(config, provider, redirectUri, request.nextUrl.searchParams.get("next") ?? "/");
    const response = NextResponse.redirect(url);
    response.cookies.set(LOGIN_STATE_COOKIE, encodeLoginState(state), {
      httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/auth", maxAge: LOGIN_STATE_TTL_MS / 1000,
    });
    return response;
  } catch (error) {
    console.error(`[auth] ${provider} 로그인 시작 실패:`, error instanceof Error ? error.message : error);
    return back("start");
  }
}
