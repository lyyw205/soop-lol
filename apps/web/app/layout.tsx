import type { Metadata } from "next";
import "./globals.css";
import "./arena.css";
import "../components/personal-profile.css";
import "./fc.css";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: {
    default: "SOOP LOL — 스트리머 롤 전적",
    template: "%s · SOOP LOL",
  },
  description:
    "SOOP 스트리머들의 롤 커리어와 스트리머 간 상대전적·맞라인 전적·상성을 모아 봅니다.",
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
