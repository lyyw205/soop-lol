import type { Metadata } from "next";
import "./globals.css";

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
        {/* Riot 정책상 필수 고지. 지우지 말 것 (docs/RESEARCH.md §6) */}
        <footer className="border-t border-ink-800 px-6 py-8 text-xs leading-relaxed text-ink-400">
          <p>
            이 사이트는 Riot Games 와 무관하며, Riot Games 가 공식적으로 보증하지 않습니다.
            Riot Games 및 관련 자산은 Riot Games, Inc. 의 상표 또는 등록상표입니다.
          </p>
          <p className="mt-1">
            계정 정보가 잘못되었거나 노출을 원하지 않으시면 문의해 주세요. 즉시 내립니다.
          </p>
        </footer>
      </body>
    </html>
  );
}
