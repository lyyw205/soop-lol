import { listCandidates } from "@soop-lol/core/lib/db/streamers";

import { setCandidateStateAction } from "@/app/admin/actions";
import { Card, EmptyState, Tag } from "@/components/ui";

export const metadata = { title: "계정 후보" };
export const dynamic = "force-dynamic";

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state = "pending" } = await searchParams;
  const candidates = await listCandidates(state);

  return (
    <div className="grid gap-6">
      <Card
        title="계정 후보"
        description="등록된 스트리머와 같은 로비에서 본 미매핑 계정입니다. 자동 등록은 하지 않습니다."
      >
        <div className="mb-4 flex gap-2 text-xs">
          {["pending", "rejected", "ignored"].map((s) => (
            <a
              key={s}
              href={`/admin/candidates?state=${s}`}
              className={`rounded-md border px-2 py-1 ${
                s === state
                  ? "border-accent-600/40 bg-accent-600/10 text-accent-400"
                  : "border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200"
              }`}
            >
              {s === "pending" ? "대기" : s === "rejected" ? "거절" : "무시"}
            </a>
          ))}
        </div>

        <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-xs leading-relaxed text-ink-400">
          <b className="text-ink-200">여기서 바로 매핑하지 않습니다.</b> 계정 매핑에는 근거가 필요하고
          (docs/PLAN.md §11-2), 근거는 사람이 확인해서 적어야 합니다. 스트리머로 확인되면 해당
          스트리머 상세 화면의 <b className="text-ink-200">계정 연결</b> 폼에서 근거와 함께 등록하세요.
          <br />
          <span className="mt-1 inline-block">
            <b className="text-ink-200">seen_count 가 신호입니다.</b> 솔랭 로비 동료는 대부분 무작위
            유저라 1회짜리는 거의 노이즈입니다. 스트리머끼리 듀오·자유랭을 돌면 숫자가 올라갑니다.
          </span>
        </div>

        {candidates.length === 0 ? (
          <div className="mt-4">
            <EmptyState>해당 상태의 후보가 없습니다.</EmptyState>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-ink-800">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink-200">
                    {c.game_name ? (
                      <>
                        {c.game_name}
                        <span className="text-ink-400">#{c.tag_line ?? "?"}</span>
                      </>
                    ) : (
                      <span className="text-ink-400">닉네임 미상</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-ink-400">{c.puuid.slice(0, 24)}…</div>
                  {c.seen_with_names.length > 0 && (
                    <div className="mt-1 text-[11px] text-ink-400">
                      같이 본 스트리머 · {c.seen_with_names.join(", ")}
                    </div>
                  )}
                </div>

                <Tag tone={c.seen_count >= 3 ? "accent" : "neutral"}>{c.seen_count}회 목격</Tag>

                {state === "pending" ? (
                  <div className="flex gap-2">
                    <form action={setCandidateStateAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="state" value="ignored" />
                      <button className="rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-400 hover:text-ink-200">
                        무시
                      </button>
                    </form>
                    <form action={setCandidateStateAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="state" value="rejected" />
                      <button className="rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-400 hover:text-lose">
                        거절
                      </button>
                    </form>
                  </div>
                ) : (
                  <form action={setCandidateStateAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="state" value="pending" />
                    <button className="rounded-md border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-400 hover:text-ink-200">
                      대기로 되돌리기
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
