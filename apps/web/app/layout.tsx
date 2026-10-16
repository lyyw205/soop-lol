import type { Metadata } from "next";
import "./globals.css";
import "./arena.css";
import "../components/personal-profile.css";
import "./fc.css";
import "./member.css";
import "./record-surfaces.css";
import "./record-theme.css";
import { SiteFooter } from "@/components/site-footer";
import { TRAP_PATH } from "@/lib/bot-guard";

export const metadata: Metadata = {
  // 게임 공간은 각자 레이아웃에서 게임명과 함께 표시한다(app/lol·app/fc).
  title: {
    default: "SOOP SEEK · 스트리머 기록실",
    template: "%s · SOOP SEEK",
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
        {/* 봇 함정 — 사람에겐 안 보이고(스크린리더도 건너뜀) robots.txt 가 금지한다. 링크를 전부 따라가는
            수집기만 밟는다(lib/bot-guard.ts). next/link 로 바꾸지 마라 — 미리 받기가 사람을 함정에 넣는다. */}
        <a href={TRAP_PATH} rel="nofollow" tabIndex={-1} aria-hidden="true" style={{ display: "none" }}>전체 기록 내보내기</a>
      </body>
    </html>
  );
}
