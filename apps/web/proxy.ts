import { NextResponse, type NextRequest } from "next/server";

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
 * ★ fail-closed: ADMIN_PASSWORD 가 없으면 **막는다.**
 *   설정을 깜빡했을 때 관리자 화면이 인터넷에 열려 있는 쪽이 훨씬 나쁘다.
 */
export const config = { matcher: ["/admin/:path*"] };

function unauthorized(message: string) {
  return new NextResponse(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="soop-lol admin", charset="UTF-8"' },
  });
}

/** 길이·내용 노출을 줄이는 상수시간 비교. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default function proxy(request: NextRequest) {
  const expectedUser = process.env.ADMIN_USER ?? "admin";
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedPassword) {
    return new NextResponse(
      "ADMIN_PASSWORD 가 설정되지 않아 관리자 화면을 잠갔습니다. .env.local 을 확인하세요.",
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized("인증이 필요합니다.");

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized("인증 형식이 올바르지 않습니다.");
  }

  const separator = decoded.indexOf(":");
  const user = separator === -1 ? decoded : decoded.slice(0, separator);
  const password = separator === -1 ? "" : decoded.slice(separator + 1);

  if (!safeEqual(user, expectedUser) || !safeEqual(password, expectedPassword)) {
    return unauthorized("아이디 또는 비밀번호가 틀렸습니다.");
  }

  return NextResponse.next();
}
