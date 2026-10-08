import type { NextRequest } from "next/server";

/**
 * 사이트 주소(origin). 로그인 콜백 주소(redirect_uri)와 로그인 뒤 돌려보낼 주소를 만들 때 쓴다.
 *
 * ★ 운영에서는 SITE_ORIGIN 을 반드시 둔다. 프록시(Caddy) 뒤에서는 요청 주소의 호스트·스킴이 등록한 주소와
 *   다를 수 있고, openid-client 는 토큰 요청의 redirect_uri 를 콜백 주소에서 만든다 — 한 글자만 달라도 로그인이 실패한다.
 * ★ 개발(SITE_ORIGIN 없음)은 요청의 Host 헤더를 쓴다. request.nextUrl.origin 을 쓰면 안 된다 —
 *   Next 가 127.0.0.1 을 localhost 로 바꿔서(실측: 127.0.0.1:34999 요청 → http://localhost:34999), 콜백이 다른 호스트로
 *   가고 로그인 상태 쿠키(호스트 단위)가 실리지 않아 로그인이 실패했다(브라우저 검증에서 확인).
 *   운영에서 Host 헤더를 믿지 않으려고 개발에서만 쓴다.
 */
export function siteOrigin(request: NextRequest): string {
  const configured = process.env.SITE_ORIGIN?.replace(/\/+$/, "");
  if (configured) return configured;
  const host = request.headers.get("host");
  if (process.env.NODE_ENV !== "production" && host) return `${request.nextUrl.protocol}//${host}`;
  if (process.env.NODE_ENV === "production") console.warn("[auth] SITE_ORIGIN 이 없다 — 로그인 콜백 주소가 프록시 뒤에서 어긋날 수 있다");
  return request.nextUrl.origin;
}
