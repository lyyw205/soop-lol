import type { NextRequest } from "next/server";

/**
 * 사이트 주소(origin). 로그인 콜백 주소(redirect_uri)를 만들 때 쓴다.
 *
 * ★ 운영에서는 SITE_ORIGIN 을 반드시 둔다. 프록시(Caddy) 뒤에서는 요청 주소의 호스트·스킴이 등록한 주소와
 *   다를 수 있고, openid-client 는 토큰 요청의 redirect_uri 를 콜백 주소에서 만든다 — 한 글자만 달라도 로그인이 실패한다.
 *   로컬 개발은 비워 두면 요청 주소를 쓴다.
 */
export function siteOrigin(request: NextRequest): string {
  return process.env.SITE_ORIGIN?.replace(/\/+$/, "") || request.nextUrl.origin;
}
