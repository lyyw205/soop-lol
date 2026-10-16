import Link from "next/link";

import { listStreamerChoices, listSubmissionQueue, type QueueItem } from "@soop-lol/core/lib/db/submission";
import { correctionLines, HOLD_REASON_LABEL, SUBMISSION_STATE_LABEL } from "@soop-lol/core/lib/metrics/submission";
import { championById } from "@soop-lol/core/lib/riot/champions";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { SetupNotice } from "@/components/admin/SetupNotice";
import { Card, EmptyState, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "제보" };

/** 열린 제보 — 경기별로 묶어 보인다(+1 많은 것·오래된 것 먼저). 처리는 상세에서. */
export default async function SubmissionQueuePage() {
  try {
    const [rows, streamers] = await Promise.all([listSubmissionQueue(), listStreamerChoices()]);
    const name = new Map(streamers.map((s) => [s.id, s.display_name]));
    const names = { streamer: (id: string) => name.get(id) ?? id.slice(0, 8), champion: (id: number) => championById(id)?.name ?? `#${id}` };
    const byMatch = new Map<string, QueueItem[]>();
    for (const r of rows) byMatch.set(r.match_id ?? "(지워진 경기)", [...(byMatch.get(r.match_id ?? "(지워진 경기)") ?? []), r]);
    return <Card title={`제보 ${rows.length}건`} description="확인 전(반영됨)은 공개 화면에 '확인 전'으로 보이고 집계에서 빠져 있습니다. 보류는 공개 화면에 아직 반영되지 않았습니다.">
      {!rows.length ? <EmptyState>열린 제보가 없습니다.</EmptyState> : <ul className="divide-y divide-ink-800">
        {[...byMatch].map(([matchId, items]) => <li key={matchId} className="py-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong>{items[0].event_name ?? "행사 없음"}</strong>
            <span className="text-ink-400">{items[0].played_at ? kstPlayedAt(new Date(items[0].played_at), "datetime") : ""} · {matchId}</span>
            {items[0].match_id && <Link href={`/admin/ck/match/${encodeURIComponent(items[0].match_id)}`} className="text-accent-400 hover:underline">검수 화면 →</Link>}
          </div>
          <ul className="mt-2 grid gap-2">
            {items.map((s) => <li key={s.id} className="rounded border border-ink-800 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={s.state === "applied" ? "warn" : "neutral"}>{SUBMISSION_STATE_LABEL[s.state]}</Tag>
                {s.hold_reason && <Tag>{HOLD_REASON_LABEL[s.hold_reason]}</Tag>}
                {s.supporters > 0 && <Tag tone="accent">같은 내용 {s.supporters}</Tag>}
                <span className="text-ink-400">{s.author ?? "탈퇴한 회원"} · {kstPlayedAt(new Date(s.created_at), "datetime")}</span>
                <Link href={`/admin/submissions/${s.id}`} className="ml-auto text-accent-400 hover:underline">처리 →</Link>
              </div>
              <ul className="mt-2 list-disc pl-5 text-ink-300">{correctionLines(s.payload, names).map((l) => <li key={l}>{l}</li>)}</ul>
            </li>)}
          </ul>
        </li>)}
      </ul>}
    </Card>;
  } catch (error) { return <SetupNotice error={error} />; }
}
