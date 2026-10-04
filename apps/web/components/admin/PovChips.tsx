"use client";

/**
 * CK 대회 검수의 시점 칩. 칩을 누르면 그 스트리머 VOD 로 검수대 전체가 바뀐다.
 * ★ 링크는 **지금 주소** 에서 만든다 — 검수대가 고른 경기·탭을 `match`·`tab` 으로 적어 두므로
 *   저라뎃 2경기 로스터를 보다가 스맵을 누르면 스맵 2경기 로스터가 바로 열린다.
 *   그 스트리머 VOD 에 그 경기가 없으면 서버가 경기를 버리고 첫 경기로 연다(탭은 유지).
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export interface PovChip {
  lead_id: string;
  source_key: string;
  title: string;
  streamer_name: string | null;
  /** 같은 이름 VOD 가 둘 이상일 때 붙이는 방송 시각. 서버에서 만들어 넘긴다(브라우저 로캘과 어긋나지 않게). */
  time_label: string;
  match_count: number;
  mismatch_open: number;
}

const KEEP = ["review", "match", "tab", "focus", "from"] as const;

export function PovChips({ slug, currentLeadId, povs }: { slug: string; currentLeadId: string; povs: PovChip[] }) {
  const params = useSearchParams();
  const sameName = (name: string | null) => povs.filter(p => p.streamer_name === name).length > 1;
  const hrefOf = (leadId: string) => {
    const q = new URLSearchParams({ pov: leadId });
    for (const key of KEEP) {
      const v = params.get(key);
      if (v) q.set(key, v);
    }
    return `/admin/ck/event/${slug}?${q}`;
  };
  return (
    <nav className="mt-2 flex flex-wrap gap-1.5" aria-label="시점 선택">
      {povs.map((p) => {
        const current = p.lead_id === currentLeadId;
        return (
          <Link key={p.lead_id} href={hrefOf(p.lead_id)} aria-current={current ? "page" : undefined}
            title={`${p.title} · 이 대회 경기 ${p.match_count}개`}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${current
              ? "border-accent-600/60 bg-accent-600/15 text-accent-400"
              : "border-ink-700 text-ink-300 hover:text-ink-100"}`}>
            {p.streamer_name ?? p.source_key}
            {sameName(p.streamer_name) && <span className="text-[10px] text-ink-500">{p.time_label}</span>}
            {p.mismatch_open > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-label={`미해결 불일치 ${p.mismatch_open}`} />}
          </Link>
        );
      })}
    </nav>
  );
}
