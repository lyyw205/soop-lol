/**
 * 관리자 인증 — HTTP Basic 판정 한 곳.
 *
 * ★ `proxy.ts` 가 /admin 화면 요청을 막고, 서버 액션은 **각자 `requireAdmin()` 을 한 번 더** 부른다.
 *   액션은 경로와 무관하게 호출될 수 있는 POST 끝점이라, 화면 경로의 matcher 만 믿으면
 *   나중에 어드민 밖에서 같은 액션을 쓰는 순간 뚫린다.
 * ★ fail-closed: ADMIN_PASSWORD 가 없으면 **막는다.** 설정을 깜빡해 열려 있는 쪽이 훨씬 나쁘다.
 */

export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

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

/** 서버 액션 첫 줄에서 부른다. 인증이 안 되면 아무것도 쓰지 않고 멈춘다. */
export async function requireAdmin(): Promise<void> {
  const { headers } = await import("next/headers");
  const result = checkBasicAuth((await headers()).get("authorization"));
  if (!result.ok) throw new Error(`관리자 인증 실패: ${result.message}`);
}
