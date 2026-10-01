import type { Metadata } from "next";

import { SiteHeader } from "@/components/public";

export const metadata: Metadata = {
  // ★ absolute: 레이아웃 기본 제목에도 부모(로비)의 템플릿이 씌워져 "… · SOOP" 이 한 번 더 붙는다.
  title: { absolute: "SOOP LOL — 스트리머 롤 전적", template: "%s · SOOP LOL" },
  description: "SOOP 스트리머들의 롤 커리어와 스트리머 간 상대전적·맞라인 전적·상성을 모아 봅니다.",
};

/** 롤 공간의 틀. 머리말은 여기서 한 번만 씌운다 — 페이지·모듈은 내용만 그린다(FC 레이아웃과 같은 모양). */
export default function LolLayout({ children }: { children: React.ReactNode }) {
  return <>
    <SiteHeader site="lol" />
    {children}
  </>;
}
