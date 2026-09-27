import Link from "next/link";
import { notFound } from "next/navigation";

import { getLeadWorkspace } from "@soop-lol/core/lib/db/ck";
import { rosterFocus } from "@/lib/ck-review-progress";
import { reviewMatchData } from "@/lib/ck-review-data";

import { CkReviewer } from "@/components/admin/CkReviewer";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const ws = await getLeadWorkspace(leadId);
  return { title: ws ? `검수 · ${ws.lead.title}` : "검수" };
}

export default async function CkReviewPage({ params, searchParams }: { params: Promise<{ leadId: string }>; searchParams: Promise<{ match?: string; focus?: string; review?: string }> }) {
  const query = await searchParams;
  const { leadId } = await params;
  const ws = await getLeadWorkspace(leadId);
  if (!ws) notFound();

  // ★ 사람 검수는 공개 값과 비교 프레임만 본다. 조사 기록(후보·탐색·관찰문)은 넘기지 않는다 —
  //   그건 `npm run ck:record` 로 본다.
  const { lead, frames, matches, streamers, events } = ws;

  // ★ 클라이언트 컴포넌트에는 Date 를 넘기지 않는다 — 직렬화 경계에서 문자열이 되므로
  //   타입이 거짓이 된다. 여기서 명시적으로 문자열로 바꿔 넘긴다.
  const clientMatches = matches.map(reviewMatchData);
  const field = rosterFocus(query.focus);
  const initial = clientMatches.find(m => m.match_id === query.match)
    ?? clientMatches.find(m => field ? m[field.count] < 10
      : query.review === "pending" ? !m.review_completed_at : false);


  return (
    <div className="ck-review-page">
      <header className="ck-review-page-head">
        <div className="min-w-0">
          <Link href="/admin/ck" className="text-xs text-ink-400 hover:text-ink-200">
            ← 경기 검수
          </Link>
          <h1 className="mt-1 truncate text-lg font-semibold text-ink-200">{lead.title}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
            <span>{new Date(lead.observed_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</span>
            {lead.channel_id && <span className="font-mono">{lead.channel_id}</span>}
            {lead.url && (
              <a href={lead.url} target="_blank" rel="noreferrer" className="hover:text-ink-200">
                VOD 열기 ↗
              </a>
            )}
          </p>
        </div>
      </header>

      <CkReviewer
        key={`${query.match ?? ""}:${query.focus ?? ""}:${query.review ?? ""}`}
        leadId={lead.id}
        vodUrl={lead.url}
        initialMatchId={initial?.match_id}
        initialFocus={query.focus}
        initialPending={query.review === "pending"}
        // 비교 프레임은 경기에 연결된 것뿐이다. 미배정 프레임은 조사의 몫이다.
        frames={frames.filter((f) => f.match_id != null).map((f) => ({
          id: f.id,
          match_id: f.match_id,
          frame_path: f.frame_path,
          at_sec: f.at_sec,
          kind: f.kind,
        }))}
        matches={clientMatches}
        streamers={streamers}
        events={events}
        vodStartedAt={typeof lead.raw.vod_started_at === "string" ? lead.raw.vod_started_at : null}
      />
    </div>
  );
}
