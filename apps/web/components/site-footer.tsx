"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { gameHomeHref, lobbyHref, type SiteGame } from "@soop-lol/core/lib/site-paths";

/**
 * 게임 선택만 있는 입구에는 푸터를 두지 않는다. 기록 화면의 고지는 해당 게임 것을 쓴다.
 */
export function SiteFooter() {
  const pathname = usePathname();
  if (pathname === lobbyHref()) return null;
  const inside = (game: SiteGame) => pathname === gameHomeHref(game) || pathname.startsWith(`${gameHomeHref(game)}/`);
  const fc = !inside("lol");
  const lol = !inside("fconline");
  return <footer className="border-t border-ink-800 px-6 py-8 text-xs leading-relaxed text-ink-400">
    {fc && <>
      <p>Data based on NEXON Open API.</p>
      <p className="mt-1">이 사이트는 NEXON 및 EA SPORTS FC 온라인의 공식 서비스가 아닙니다.</p>
    </>}
    {lol && <p className={fc ? "mt-1" : undefined}>이 사이트는 Riot Games 와 무관하며, Riot Games 가 공식적으로 보증하지 않습니다.
      Riot Games 및 관련 자산은 Riot Games, Inc. 의 상표 또는 등록상표입니다.</p>}
    <p className="mt-1">계정 정보가 잘못되었거나 노출을 원하지 않으시면 <Link href="/support">건의·문의로 알려 주세요.</Link> 즉시 내립니다.</p>
  </footer>;
}
