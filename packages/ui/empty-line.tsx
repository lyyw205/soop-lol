import type { ReactNode } from "react";

/**
 * "여기엔 아무것도 없다" 를 한 줄로 말하는 자리.
 *
 * ★ 왜 apps/web/components/public.tsx 가 아니라 여기 있나
 *   그 파일은 모듈 레지스트리(`@soop-lol/modules/registry`)를 import 한다. 레지스트리는
 *   서버 코드(DB 클라이언트까지)를 끌고 오므로 **클라이언트 컴포넌트가 못 쓴다** —
 *   챔피언 표에서 실제로 `Can't resolve 'fs'` 로 터졌다. 표시 전용이라 packages/ui 가 맞다.
 */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-sm text-ink-400">{children}</p>;
}
