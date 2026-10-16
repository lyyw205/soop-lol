import type { Metadata } from "next";

import { SiteHeader } from "@/components/public";

export const metadata: Metadata = {
  // 부모의 제목 템플릿으로 사이트명이 중복되지 않도록 기본 제목은 absolute를 쓴다.
  title: { absolute: "리그 오브 레전드 · SOOP SEEK", template: "%s · LOL · SOOP SEEK" },
  description: "SOOP 스트리머들의 롤 커리어와 스트리머 간 상대전적·맞라인 전적·상성을 모아 봅니다.",
};

/** 롤 공간의 틀. 머리말은 여기서 한 번만 씌운다 — 페이지·모듈은 내용만 그린다(FC 레이아웃과 같은 모양). */
export default function LolLayout({ children }: { children: React.ReactNode }) {
  return <>
    <SiteHeader site="lol" />
    {children}
  </>;
}
