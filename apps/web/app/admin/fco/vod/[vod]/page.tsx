import Link from "next/link";
import { notFound } from "next/navigation";

import { getFcoBroadcastWorkspace } from "@soop-lol/core/lib/games/fconline/broadcast";
import { listFcoEventOptions } from "@soop-lol/core/lib/games/fconline/context";

import { FcoBroadcastWorkbench } from "@/components/admin/FcoBroadcastWorkbench";
import { loadViewerVods } from "@/lib/vod-frames";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ vod: string }> }) {
  const { vod } = await params;
  const ws = await getFcoBroadcastWorkspace(vod);
  return { title: ws ? `FC 방송 · ${ws.title ?? ws.vod}` : "FC 방송" };
}

/** 방송 작업대 — 이 방송이 **집**인 경기들(core/games/fconline/broadcast.ts). 경기마다 시점(넥슨 기록·VOD들)을 칩으로 바꿔 본다. */
export default async function FcoBroadcastPage({ params, searchParams }: { params: Promise<{ vod: string }>; searchParams: Promise<{ match?: string }> }) {
  const { vod } = await params;
  const { match } = await searchParams;
  const ws = await getFcoBroadcastWorkspace(vod);
  if (!ws) notFound();
  // 시점마다 다른 VOD 일 수 있다 — 그 VOD 들의 원본·썸네일을 다 준다.
  const vodIds = [...new Set(ws.matches.flatMap((m) => m.views.map((v) => v.vod)).filter((v): v is string => !!v))];
  const [vods, eventOptions] = await Promise.all([loadViewerVods(vodIds), listFcoEventOptions()]);

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
            <span>↑↓ 경기 · ← → 프레임 · 칩으로 시점 전환</span>
          </p>
        </div>
      </header>
      <FcoBroadcastWorkbench ws={ws} vods={vods} eventOptions={eventOptions} initialMatchId={match} />
    </div>
  );
}
