import Link from "next/link";
import { notFound } from "next/navigation";

import { listFcoEventOptions } from "@soop-lol/core/lib/games/fconline/context";
import { buildMatchUnits, listPickableStreamers } from "@soop-lol/core/lib/games/fconline/match-units";
import { getFcoSession } from "@soop-lol/core/lib/games/fconline/sessions";

import { FcoMatchWorkbench } from "@/components/admin/FcoMatchWorkbench";
import { loadViewerVods } from "@/lib/vod-frames";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getFcoSession(decodeURIComponent(id));
  return { title: s ? `FC 대전 · ${s.title}` : "FC 대전" };
}

/**
 * 대전 작업대 — 누가 누구와 한 자리에서 연달아 한 경기 묶음(core/games/fconline/sessions.ts).
 * 경기마다 시점(넥슨 기록·그 경기를 본 방송들)을 칩으로 바꿔 보고, 맥락은 [대전] 탭에서 한 번에 정할 수 있다.
 */
export default async function FcoSessionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ match?: string }> }) {
  const { id } = await params;
  const { match } = await searchParams;
  const session = await getFcoSession(decodeURIComponent(id));
  if (!session) notFound();
  const built = await buildMatchUnits(session.match_ids);
  const matches = session.match_ids.map((mid) => built.find((m) => m.match_id === mid)).filter((m): m is NonNullable<typeof m> => !!m);
  const vodIds = [...new Set(matches.flatMap((m) => m.views.map((v) => v.vod)).filter((v): v is string => !!v))];
  const [vods, eventOptions, streamers] = await Promise.all([loadViewerVods(vodIds), listFcoEventOptions(), listPickableStreamers()]);

  return (
    <div className="ck-review-page">
      <header className="ck-review-page-head">
        <div className="min-w-0">
          <Link href="/admin/fco" className="text-xs text-ink-400 hover:text-ink-200">← FC 맥락 검수</Link>
          <h1 className="mt-1 truncate text-lg font-semibold text-ink-200">{session.title}</h1>
          <p className="mt-0.5 text-[11px] text-ink-400">↑↓ 경기 · ← → 프레임 · 칩으로 시점(넥슨 기록·방송) 전환 · [대전] 탭에서 맥락 한 번에</p>
        </div>
      </header>
      <FcoMatchWorkbench matches={matches} streamers={streamers} vods={vods} eventOptions={eventOptions} initialMatchId={match}
        session={{ kind: session.kind, title: session.title, people: session.people, vods: session.vods }} queueTitle="이 대전의 경기" />
    </div>
  );
}
