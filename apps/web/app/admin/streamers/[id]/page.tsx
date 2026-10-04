import { ConfirmSubmitButton } from "@/components/admin/ConfirmSubmitButton";
import { AdminHistory } from "@/components/admin/AdminHistory";
import { AdminBackLink } from "@/components/admin/AdminBackLink";
import { notFound } from "next/navigation";

import {
  getStreamer,
  listCareerEvents,
  listStreamerAccounts,
} from "@soop-lol/core/lib/db/streamers";
import { formatRank } from "@soop-lol/core/lib/metrics/lp";

import {
  deleteCareerEventAction,
  setMainAccountAction,
  toggleAccountVisibilityAction,
  unlinkAccountAction,
} from "@/app/admin/actions";
import { AccountLinkForm } from "@/components/admin/AccountLinkForm";
import { CareerEventForm } from "@/components/admin/CareerEventForm";
import { SetupNotice } from "@/components/admin/SetupNotice";
import { StreamerEditForm } from "@/components/admin/StreamerForms";
import { Card, ConfidenceBadge, EmptyState, Tag } from "@/components/ui";
import { hasRiotKey } from "@/lib/riot";

export const dynamic = "force-dynamic";

export default async function StreamerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let streamer, accounts, career;
  try {
    streamer = await getStreamer(id);
    if (!streamer) notFound();
    [accounts, career] = await Promise.all([
      listStreamerAccounts(streamer.id),
      listCareerEvents(streamer.id),
    ]);
  } catch (e) {
    // notFound() 는 예외로 흐르므로 다시 던진다.
    if (e && typeof e === "object" && "digest" in e) throw e;
    return <SetupNotice error={e} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <AdminBackLink fallback="/admin/streamers">스트리머 목록</AdminBackLink>
        <h1 className="text-xl font-semibold text-ink-200">{streamer.display_name}</h1>
        {streamer.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
      </div>

      <Card title="기본 정보">
        <StreamerEditForm streamer={streamer} />
      </Card>

      <Card
        title={`라이엇 계정 ${accounts.length}개`}
        description="계정 연결에는 확인 근거가 필요합니다."
      >
        {accounts.length === 0 ? (
          <EmptyState>연결된 계정이 없습니다. 아래에서 추가하세요.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-800">
            {accounts.map((a) => (
              <li key={a.puuid} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink-200">
                      {a.game_name ? `${a.game_name}#${a.tag_line ?? "?"}` : "(닉네임 미조회)"}
                    </span>
                    {a.is_main && <Tag tone="accent">대표</Tag>}
                    {a.label && <Tag>{a.label}</Tag>}
                    <ConfidenceBadge confidence={a.confidence} />
                    {a.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
                  </div>
                  <div className="tabular mt-1 text-xs text-ink-400">
                    {a.tier ? formatRank({ tier: a.tier, division: a.division, leaguePoints: a.league_points }) : "티어 미수집"}
                    {" · "}
                    <span className="font-mono">{a.puuid.slice(0, 16)}…</span>
                  </div>
                  {(a.evidence?.url || a.evidence?.note) && (
                    <div className="mt-1 text-[11px] text-ink-400">
                      근거:{" "}
                      {a.evidence.url ? (
                        <a href={a.evidence.url} className="text-accent-500 hover:underline" target="_blank" rel="noreferrer">
                          {a.evidence.url}
                        </a>
                      ) : null}
                      {a.evidence.url && a.evidence.note ? " · " : null}
                      {a.evidence.note}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {!a.is_main && (
                    <form action={setMainAccountAction}>
                      <input type="hidden" name="streamer_id" value={streamer.id} />
                      <input type="hidden" name="puuid" value={a.puuid} />
                      <button className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-400 hover:text-ink-200">
                        대표로
                      </button>
                    </form>
                  )}
                  <form action={toggleAccountVisibilityAction}>
                    <input type="hidden" name="streamer_id" value={streamer.id} />
                    <input type="hidden" name="puuid" value={a.puuid} />
                    <input
                      type="hidden"
                      name="next_visibility"
                      value={a.visibility === "hidden" ? "public" : "hidden"}
                    />
                    <button className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-400 hover:text-ink-200">
                      {a.visibility === "hidden" ? "공개" : "숨기기"}
                    </button>
                  </form>
                  <form action={unlinkAccountAction}>
                    <input type="hidden" name="streamer_id" value={streamer.id} />
                    <input type="hidden" name="puuid" value={a.puuid} />
                    <ConfirmSubmitButton message="이 계정의 스트리머 연결을 해제할까요? 경기 원본은 유지됩니다.">연결 해제</ConfirmSubmitButton>
                  </form>
                </div>
                <details className="w-full"><summary className="cursor-pointer text-xs text-accent-400">계정 정보·근거 수정</summary><div className="mt-3"><AccountLinkForm streamerId={streamer.id} hasKey={hasRiotKey()} account={a} /></div></details>
              </li>
            ))}
          </ul>
        )}

        <details className="mt-4 border-t border-ink-800 pt-4" open={accounts.length === 0}><summary className="cursor-pointer text-sm text-accent-400">계정 추가</summary><div className="mt-3"><AccountLinkForm streamerId={streamer.id} hasKey={hasRiotKey()} /></div></details>
      </Card>

      <Card
        title={`커리어 ${career.length}건`}
        description="대회 성적은 Riot API 에 없습니다. 전부 수기이고, 공개 화면에서도 '수기' 로 표시됩니다."
      >
        {career.length === 0 ? (
          <EmptyState>등록된 커리어가 없습니다.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-800">
            {career.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink-200">{c.title}</span>
                    {c.placement && <Tag tone="accent">{c.placement}</Tag>}
                    <Tag>수기</Tag>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-400">
                    {[c.role, c.team_name, c.date_from].filter(Boolean).join(" · ") || "—"}
                    {c.source_url && <a href={c.source_url} target="_blank" rel="noreferrer" className="ml-3 text-accent-400">출처 열기 ↗</a>}
                  </div>
                </div>
                <details className="order-last w-full"><summary className="cursor-pointer text-xs text-accent-400">커리어 수정</summary><div className="mt-3"><CareerEventForm streamerId={streamer.id} career={c} /></div></details>
                <form action={deleteCareerEventAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="streamer_id" value={streamer.id} />
                  <ConfirmSubmitButton message="이 커리어를 삭제할까요? 내부 이력에는 이전 값이 남습니다.">삭제</ConfirmSubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}

        <details className="mt-4 border-t border-ink-800 pt-4"><summary className="cursor-pointer text-sm text-accent-400">커리어 추가</summary><div className="mt-3"><CareerEventForm streamerId={streamer.id} /></div></details>
      </Card>
      <AdminHistory scope="streamer" id={streamer.id} />
    </div>
  );
}
