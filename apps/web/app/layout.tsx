import type { Metadata } from "next";
import "./globals.css";
import "./arena.css";
import "../components/personal-profile.css";
import "./fc.css";
import "./member.css";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  // 로비(플랫폼 공간) 이름. 게임 공간은 각자 레이아웃에서 덮어쓴다(app/lol·app/fc).
  // ★ 사이트 이름은 아직 미정 — 임시로 "SOOP" (docs/PLATFORM-LAYER-PLAN.md §미정)
  title: {
    default: "SOOP — 스트리머 기록실",
    template: "%s · SOOP",
  },
  description:
    "SOOP 스트리머들의 롤·FC 온라인 기록과 스트리머끼리의 상대전적을 모아 봅니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-dvh">
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
