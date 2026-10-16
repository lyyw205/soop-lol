import Link from "next/link";
import { notFound } from "next/navigation";

import { getSubmissionForAdmin, listStreamerChoices, listSubmissionQueue } from "@soop-lol/core/lib/db/submission";
import { correctionLines, HOLD_REASON_LABEL, SUBMISSION_STATE_LABEL } from "@soop-lol/core/lib/metrics/submission";
import { championById } from "@soop-lol/core/lib/riot/champions";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { DecideSubmissionForm } from "@/components/admin/SubmissionForms";
import { Card, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "제보 처리" };

const show = (v: unknown) => (v === null || v === undefined ? "비움" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** 제보 하나 — 제안 · 남긴 이력(전후 값) · 되돌릴 때 걸리는 칸 · 처리. */
export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSubmissionForAdmin((await params).id);
  if (!s) notFound();
  const [streamers, queue] = await Promise.all([listStreamerChoices(), listSubmissionQueue()]);
  const name = new Map(streamers.map((x) => [x.id, x.display_name]));
  const names = { streamer: (id: string) => name.get(id) ?? id.slice(0, 8), champion: (id: number) => championById(id)?.name ?? `#${id}` };
  const open = s.state === "applied" || s.state === "held";
  const siblings = queue.filter((q) => q.id !== s.id && q.match_id === s.match_id)
    .map((q) => ({ id: q.id, label: `${SUBMISSION_STATE_LABEL[q.state]} · ${correctionLines(q.payload, names)[0] ?? q.id.slice(0, 8)}` }));
  return <div className="grid gap-5">
    <Link href="/admin/submissions" className="text-sm text-ink-400 hover:underline">← 제보 목록</Link>
    <Card title={`${s.event_name ?? "행사 없음"} · ${s.played_at ? kstPlayedAt(new Date(s.played_at), "datetime") : ""}`}
      description={`${s.author ?? "탈퇴한 회원"} · ${kstPlayedAt(new Date(s.created_at), "datetime")} 접수`}>
      <div className="flex flex-wrap gap-2 text-sm">
        <Tag tone={s.state === "applied" ? "warn" : "neutral"}>{SUBMISSION_STATE_LABEL[s.state]}</Tag>
        {s.hold_reason && <Tag>{HOLD_REASON_LABEL[s.hold_reason]}</Tag>}
        {s.supporters > 0 && <Tag tone="accent">같은 내용 {s.supporters}</Tag>}
        {s.match_id && <Link href={`/admin/ck/match/${encodeURIComponent(s.match_id)}`} className="text-accent-400 hover:underline">검수 화면에서 직접 고치기 →</Link>}
      </div>
      <h3 className="mt-4 text-sm font-semibold">제안</h3>
      <ul className="mt-1 list-disc pl-5 text-sm text-ink-300">{correctionLines(s.payload, names).map((l) => <li key={l}>{l}</li>)}</ul>
      {(s.note || s.evidence_url) && <div className="mt-3 text-sm text-ink-300">
        {s.evidence_url && <p>근거: <a href={s.evidence_url} target="_blank" rel="noreferrer noopener" className="text-accent-400 hover:underline">{s.evidence_url}</a></p>}
        {s.note && <p className="whitespace-pre-wrap">메모: {s.note}</p>}
      </div>}
      {s.changes.length > 0 && <>
        <h3 className="mt-4 text-sm font-semibold">이 제보가 바꾼 칸</h3>
        <table className="mt-1 w-full text-left text-xs text-ink-300"><tbody>
          {s.changes.map((c) => <tr key={c.id} className="border-t border-ink-800">
            <td className="py-1 pr-2">{c.entity === "participant" ? `${c.entity_key}번 자리` : "경기"}</td>
            <td className="pr-2">{c.field}</td><td className="pr-2">{show(c.before)}</td><td>→ {show(c.after)}</td>
          </tr>)}
        </tbody></table>
      </>}
      {s.conflicts.length > 0 && <p className="mt-3 text-sm text-amber-400">이 제보 뒤에 같은 칸이 또 바뀌어 반려(되돌리기)를 할 수 없습니다: {s.conflicts.join(", ")} — 검수 화면에서 직접 고친 뒤 확인하세요.</p>}
      {s.decided_at && <p className="mt-3 text-sm text-ink-400">처리: {s.decided_by} · {kstPlayedAt(new Date(s.decided_at), "datetime")}{s.decision_note ? ` · ${s.decision_note}` : ""}</p>}
      {open && <div className="mt-5"><DecideSubmissionForm id={s.id} held={s.state === "held"} duplicateOptions={siblings} /></div>}
    </Card>
  </div>;
}
