import { NextResponse, type NextRequest } from "next/server";

import { checkBasicAuth } from "./lib/admin-auth";

/**
 * 관리자 화면 보호 — HTTP Basic.
 *
 * ★ 파일 이름이 `proxy.ts` 인 이유: Next 16 에서 `middleware` 규약이 `proxy` 로 바뀌었다.
 *   `middleware.ts` 로 두면 빌드가 deprecation 경고를 낸다. export 는 default 또는
 *   `proxy` 라는 이름이어야 한다.
 *
 * MVP 수준이다. 스트리머 계정 매핑을 다루는 화면이라 열어두면 안 되지만,
 * 세션·역할 관리를 지금 만들 이유도 없다. 공개 제보 폼이 생기는 시점에
 * 제대로 된 인증으로 갈아탄다.
 *
 * ★ 판정은 `lib/admin-auth.ts` 한 곳이다 — 서버 액션도 같은 판정(`requireAdmin`)을 다시 부른다.
 */
export const config = { matcher: ["/admin/:path*"] };

export default function proxy(request: NextRequest) {
  const result = checkBasicAuth(request.headers.get("authorization"));
  if (result.ok) return NextResponse.next();
  return new NextResponse(result.message, {
    status: result.status,
    headers: result.status === 401
      ? { "WWW-Authenticate": 'Basic realm="soop-lol admin", charset="UTF-8"' }
      : undefined,
  });
}
