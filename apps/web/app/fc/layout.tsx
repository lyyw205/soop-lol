import type { Metadata } from "next";
import { PageShell, SiteHeader } from "@/components/public";

export const metadata: Metadata = {
  // 부모의 제목 템플릿으로 사이트명이 중복되지 않도록 기본 제목은 absolute를 쓴다.
  title: { absolute: "FC 온라인 · SOOP SEEK", template: "%s · FC 온라인 · SOOP SEEK" },
  description: "SOOP 스트리머의 FC 온라인 개인기록, 상대전적, 대회와 경기 분석",
};

/** FC 공간의 틀. 머리말은 로비·롤과 같은 부품이다(메뉴 규칙은 SiteHeader 한 곳). */
export default function FcLayout({ children }: { children: React.ReactNode }) {
  return <div className="fc-site">
    <SiteHeader site="fconline" />
    <PageShell>{children}</PageShell>
  </div>;
}
