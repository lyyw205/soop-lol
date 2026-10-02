import Link from "next/link";
import { notFound } from "next/navigation";

import { getScreenReviewWorkspace } from "@soop-lol/core/lib/games/fconline/screen-review";

import { FcoScreenReviewer } from "@/components/admin/FcoScreenReviewer";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ vod: string }> }) {
  const { vod } = await params;
  const ws = await getScreenReviewWorkspace(vod);
  return { title: ws ? `FC 화면 경기 · ${ws.title ?? ws.vod}` : "FC 화면 경기" };
}

export default async function FcoScreenReviewPage({ params, searchParams }: { params: Promise<{ vod: string }>; searchParams: Promise<{ match?: string }> }) {
  const { vod } = await params;
  const { match } = await searchParams;
  const ws = await getScreenReviewWorkspace(vod);
  if (!ws) notFound();

  return (
    <div className="ck-review-page">
      <header className="ck-review-page-head">
        <div className="min-w-0">
          <Link href="/admin/fco" className="text-xs text-ink-400 hover:text-ink-200">← FC 맥락 검수</Link>
          <h1 className="mt-1 truncate text-lg font-semibold text-ink-200">{ws.title ?? `VOD ${ws.vod}`}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
            {ws.streamer && <span>{ws.streamer}</span>}
            {ws.channel_id && <span className="font-mono">{ws.channel_id}</span>}
            <a href={ws.url} target="_blank" rel="noreferrer" className="hover:text-ink-200">VOD 열기 ↗</a>
          </p>
        </div>
      </header>
      <FcoScreenReviewer ws={ws} initialMatchId={match} />
    </div>
  );
}
