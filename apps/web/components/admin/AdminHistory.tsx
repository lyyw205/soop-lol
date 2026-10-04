"use client";
import { useState } from "react";
import { loadAdminHistory } from "@/app/admin/history-actions";
import type { AdminHistoryRow } from "@soop-lol/core/lib/db/admin-history";
import { kstPlayedAt } from "@soop-lol/core/lib/time";
export function AdminHistory({ scope, id }: { scope: "match" | "streamer" | "schedule" | "candidate" | "event"; id: string }) {
  const [rows, setRows] = useState<AdminHistoryRow[] | null>(null), [error, setError] = useState("");
  const load = async () => { setError(""); try { setRows(await loadAdminHistory(scope, id)); } catch { setError("이력을 불러오지 못했습니다. 다시 시도해 주세요."); } };
  return <details className="ck-review-panel min-w-0 p-3" onToggle={e => { if (e.currentTarget.open) void load(); }}>
    <summary className="cursor-pointer text-xs text-ink-300">내부 변경 이력</summary>
    <p className="my-2 text-[11px] text-ink-400">자동 갱신 포함 · 최근 100건 · 이전 값과 저장된 값을 비교합니다.</p>
    {error && <p role="alert" className="text-xs text-red-400">{error} <button type="button" onClick={() => void load()}>다시 시도</button></p>}
    {!error && rows === null && <p className="text-xs">불러오는 중…</p>}
    {rows?.length === 0 && <p className="text-xs text-ink-400">기록된 변경이 없습니다.</p>}
    <ul className="divide-y divide-ink-800">{rows?.map(row => <li key={row.id} className="py-2 text-xs"><details>
      <summary className="cursor-pointer break-all text-ink-300">{kstPlayedAt(new Date(row.changed_at), "datetime")} · {row.entity} · {row.operation === "DELETE" ? "삭제" : row.operation === "INSERT" ? "추가" : "수정"}</summary>
      <div className="mt-2 grid gap-2"><p>변경 전</p><pre className="whitespace-pre-wrap break-all text-[11px] text-ink-400">{JSON.stringify(row.before, null, 2) ?? "없음"}</pre><p>변경 후</p><pre className="whitespace-pre-wrap break-all text-[11px] text-ink-300">{JSON.stringify(row.after, null, 2) ?? "없음"}</pre></div>
    </details></li>)}</ul>
  </details>;
}
