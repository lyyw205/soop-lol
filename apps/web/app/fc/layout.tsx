import type { Metadata } from "next";
import { PageShell, SiteHeader } from "@/components/public";

export const metadata: Metadata = {
  // ★ absolute: 레이아웃 기본 제목에도 부모(로비)의 템플릿이 씌워져 "… · SOOP" 이 한 번 더 붙는다.
  title: { absolute: "SOOP FC 온라인", template: "%s · SOOP FC 온라인" },
  description: "SOOP 스트리머의 FC 온라인 개인기록, 상대전적, 대회와 경기 분석",
};

/** FC 공간의 틀. 머리말은 로비·롤과 같은 부품이다(메뉴 규칙은 SiteHeader 한 곳). */
export default function FcLayout({ children }: { children: React.ReactNode }) {
  return <div className="fc-site">
    <SiteHeader site="fconline" />
    <PageShell>{children}</PageShell>
  </div>;
}
