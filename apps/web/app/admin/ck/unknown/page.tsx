import Link from "next/link";

import { countUnidentifiedNames, listUnidentifiedParticipants } from "@soop-lol/core/lib/db/ck";
import { listStreamers } from "@soop-lol/core/lib/db/streamers";

import { LinkUnknownForm } from "@/components/admin/LinkUnknownForm";
import { kstDateString } from "@soop-lol/core/lib/time";

export const dynamic = "force-dynamic";

/**
 * **미확인 참가자 — 조사해서 채울 목록.**
 *
 * ★ 왜 이 화면이 필요한가: 결과 화면에서 이름은 읽었는데 우리 명단에 없는 사람이 있다.
 *   그 자리는 이제 공개 로스터에도 인게임명으로 선다(0022) — 5대5 를 4명으로 그리지
 *   않기 위해서다. 다만 **사람이 안 붙어 있으면 상대전적에는 못 들어간다**(조우는 사람과
 *   사람 사이의 사실이다). 그래서 "누구인지 알아내면 되살아날 자리" 를 한 곳에 모은다.
 *
 * ★ 등장 횟수 순이 곧 조사 순서다. 한 내전의 네 세트에 다 나온 사람을 한 번 알아내면
 *   네 경기가 한꺼번에 채워진다.
 */
const PAGE = 100;

export default async function UnknownParticipantsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: raw } = await searchParams;
  const page = Math.max(1, Math.floor(Number(raw) || 1));
  const [rows, total, streamers] = await Promise.all([
    listUnidentifiedParticipants(PAGE, (page - 1) * PAGE),
    countUnidentifiedNames(),
    listStreamers(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // ★ 잘렸다는 사실을 숨기지 않는다. 예전엔 100명에서 말없이 끊겨 102번째 이름이 안 보였다.
  const pager = pages > 1 && (
    <nav className="flex items-center gap-3 text-xs text-ink-400">
      <span>전체 {total}명 · {page}/{pages}쪽</span>
      {page > 1 && <Link href={`/admin/ck/unknown?page=${page - 1}`} className="text-accent-400 hover:underline">이전</Link>}
      {page < pages && <Link href={`/admin/ck/unknown?page=${page + 1}`} className="text-accent-400 hover:underline">다음</Link>}
    </nav>
  );

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-lg text-ink-200">미확인 참가자</h1>
        <p className="max-w-2xl text-xs leading-relaxed text-ink-400">
          화면에서 이름은 읽었는데 아직 사람을 못 붙인 자리입니다. 공개 로스터에는{" "}
          <b className="text-ink-200">인게임명 그대로 서 있습니다</b> — 자리를 비우면 5대5 가 4명으로
          보이기 때문입니다. 다만 사람이 붙기 전까지는 상대전적·챔피언 통계에 들어가지 않습니다.
        </p>
        <p className="text-[11px] text-ink-600">
          계정(puuid)은 아는데 사람을 모르는 공개 큐 후보는{" "}
          <Link href="/admin/candidates" className="text-accent-400 hover:underline">
            계정 후보
          </Link>{" "}
          쪽입니다. 여기는 방송 화면을 읽어 넣은 자리입니다.
        </p>
        {pages <= 1 && total > 0 && <p className="text-[11px] text-ink-600">전체 {total}명</p>}
      </header>

      {pager}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-ink-800 bg-ink-900/60 p-6 text-center text-sm text-ink-400">
          미확인 자리가 없습니다. 판독한 참가자에 전부 사람이 붙어 있습니다.
        </p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((row) => (
            <li key={row.observed_name} className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <strong className="text-sm text-ink-200">{row.observed_name}</strong>
                <span className="text-[11px] text-amber-400">{row.seats}자리</span>
                <span className="text-[11px] text-ink-600">
                  {kstDateString(row.first_seen)}
                  {row.last_seen.getTime() !== row.first_seen.getTime()
                    && ` ~ ${kstDateString(row.last_seen)}`}
                </span>
              </div>

              <dl className="mt-2 grid gap-1 text-[11px] leading-relaxed">
                {row.teammates.length > 0 && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-600">같은 팀</dt>
                    <dd className="text-ink-200">{row.teammates.join(" · ")}</dd>
                  </div>
                )}
                {row.champions.length > 0 && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-600">챔피언</dt>
                    <dd className="text-ink-400">{row.champions.join(" · ")}</dd>
                  </div>
                )}
                <div className="flex gap-2">
                  <dt className="shrink-0 text-ink-600">경기</dt>
                  <dd className="font-mono text-ink-400">{row.match_ids.join(", ")}</dd>
                </div>
              </dl>

              {/* ★ 확인한 시리즈·자리를 골라 한 번에 연결한다. 이름 자체는 식별자가 아니다. */}
              <LinkUnknownForm targets={row.targets} />
            </li>
          ))}
        </ul>
      )}

      {pager}

      <datalist id="admin-streamers">
        {streamers.map((s) => (
          <option key={s.id} value={s.slug}>
            {s.display_name}
          </option>
        ))}
      </datalist>
    </div>
  );
}
