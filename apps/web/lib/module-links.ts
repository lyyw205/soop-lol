/**
 * 모듈이 채우는 자리로 가는 링크.
 *
 * ★ core 는 모듈 **이름**을 모른다
 *   "상대전적" 이라는 **역할**을 등록부에 묻고, 그 역할을 채우는 모듈의 경로를 받는다.
 *   versus 모듈을 지우면 여기가 null 을 돌려주고 링크는 저절로 사라진다 —
 *   core 코드는 한 줄도 안 고친다(계약 4조: core 는 모듈을 import 하지 않는다).
 */

import { moduleProviding } from "@soop-lol/modules/registry";

/** 두 스트리머의 상대전적 화면. 그 역할을 채우는 모듈이 없으면 null. */
export function versusHref(aSlug: string, bSlug: string): string | null {
  const mod = moduleProviding("versus");
  const base = mod?.routes[0]?.path;
  if (!base) return null;
  return `${base}?a=${encodeURIComponent(aSlug)}&b=${encodeURIComponent(bSlug)}`;
}

/** 상대전적 첫 화면(선택기). 없으면 null. */
export function versusIndexHref(): string | null {
  return moduleProviding("versus")?.routes[0]?.path ?? null;
}
