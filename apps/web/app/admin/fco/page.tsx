import Link from "next/link";

import { getFcoReviewWorkspace, listFcoCrossClues, type FcoReviewUnit } from "@soop-lol/core/lib/games/fconline/context";
import { listFcoBroadcastUnits, type FcoBroadcastUnit } from "@soop-lol/core/lib/games/fconline/broadcast";

import { Card, EmptyState, Tag } from "@/components/ui";
import { FCO_STATUS_LABEL } from "@/lib/admin-labels";

export const metadata = { title: "FC 맥락 검수" };
export const dynamic = "force-dynamic";

/**
 * 검수 대상 목록 (1층). 하나를 고르면 작업대(2층)로 들어간다 — CK 판독 검수와 같은 구조다.
 * 목록은 표 하나이고 탭으로 가른다. ⚠ 미조사는 검수 대상이 아니라 **조사 대상**이라
 * 기본 탭에서 빠진다 — 승인할 제안이 없는 행이 승인 큐를 채우면 안 된다.
 */

const kst = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });

const unitHref = (u: FcoReviewUnit) =>
  u.kind === "event" ? `/admin/fco/event-${u.event!.id}` : `/admin/fco/${u.matches[0].provider_match_id}`;

const STATUS_LABEL = FCO_STATUS_LABEL;

/**
 * 목록의 한 줄 — **경기 하나는 한 줄에만** 나온다(집 단위, core/broadcast.ts).
 *   대회 단위   행사에 붙은 경기들
 *   방송 단위   그 방송이 처음 본 경기들(넥슨 기록이 있든 없든, 상대가 일반 유저여도). 누르면 방송 작업대 /admin/fco/vod/<VOD>
 *   경기 단위   VOD 로 본 적이 없는 넥슨 경기(스트리머끼리) — 기존 맥락 검수
 */
type Row = { type: "unit"; unit: FcoReviewUnit } | { type: "screen"; vod: FcoBroadcastUnit };

const EMPTY: Record<string, string> = {
  pending: "승인 대기 중인 조사가 없습니다.",
  confirmed: "아직 승인한 단위가 없습니다.",
  todo: "조사가 필요한 경기가 없습니다.",
  all: "공개 스트리머 간 FC 경기가 없습니다. 수집은 `npm run worker -- fco` 가 합니다.",
  clues: "LoL 조사가 남긴 FC 화면 단서가 없습니다.",
};

export default async function FcoReviewListPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view = "pending" } = await searchParams;
  const [allUnits, clues, screens] = await Promise.all([getFcoReviewWorkspace(), listFcoCrossClues(), listFcoBroadcastUnits()]);
  // 방송 단위가 집인 경기는 경기 단위로 따로 세우지 않는다(같은 경기가 두 줄이 되지 않게). 대회 단위는 그대로.
  const homed = new Set(screens.flatMap((v) => v.match_ids));
  const units = allUnits.filter((u) => u.kind === "event" || !u.matches.some((m) => homed.has(m.match_id)));

  const unitRows = (list: FcoReviewUnit[]): Row[] => list.map((unit) => ({ type: "unit", unit }));
  const screenRows = (list: FcoBroadcastUnit[]): Row[] => list.map((vod) => ({ type: "screen", vod }));
  const groups: Record<string, Row[]> = {
    pending: [...unitRows(units.filter((u) => u.pending)), ...screenRows(screens.filter((v) => v.completed < v.total))],
    confirmed: [...unitRows(units.filter((u) => u.confirmed)), ...screenRows(screens.filter((v) => v.completed === v.total))],
    todo: unitRows(units.filter((u) => u.status === "uninvestigated")),
    all: [...unitRows(units), ...screenRows(screens)],
  };
  const TABS = [
    { key: "pending", label: "승인 대기" },
    { key: "confirmed", label: "확인됨" },
    { key: "todo", label: "조사 필요" },
    { key: "all", label: "전체" },
  ] as const;
  const current = view === "clues" && clues.length ? "clues" : (groups[view] ? view : "pending");
  const visible = groups[current] ?? [];

  return (
    <div className="grid gap-6">
      <Card
        title="FC 맥락 검수"
        description="경기 사실(승패·점수)은 넥슨 API 가 정본입니다. 여기서 판정하는 것은 「무슨 판이었나」 — 단순 친선 / CK / 대회 — 뿐입니다."
      >
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          {TABS.map((t) => (
            <a
              key={t.key}
              href={`/admin/fco?view=${t.key}`}
              className={`rounded-md border px-2 py-1 ${
                t.key === current
                  ? "border-accent-600/40 bg-accent-600/10 text-accent-400"
                  : "border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200"
              }`}
            >
              {t.label} <b className="ml-0.5 font-semibold">{groups[t.key].length}</b>
            </a>
          ))}
          {/* ★ 이어서 할 일의 다른 축 — LoL 조사가 봤지만 **아직 어느 경기인지 모르는** 화면. */}
          {clues.length > 0 && (
            <a
              href="/admin/fco?view=clues"
              className={`ml-auto rounded-full border px-3 py-1 text-xs ${
                current === "clues"
                  ? "border-amber-400/60 bg-amber-400/10 text-amber-400"
                  : "border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
              }`}
              title="LoL 조사 중 실제로 연 화면에 FC 가 보였던 지점 — 시각대의 API 경기와 대조합니다"
            >
              교차 단서 {clues.length} →
            </a>
          )}
        </div>

        <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-xs leading-relaxed text-ink-400">
          <b className="text-ink-200">매치 타입(모드)은 맥락의 증거가 아닙니다.</b> 친선 모드로도 컵·CK 를 합니다.
          <b className="text-ink-200"> VOD 가 없어도 경기는 있었던 것</b>이고, 그건 「맥락 미확인」이지 「단순 친선」이 아닙니다.
          <br />
          <span className="mt-1 inline-block">
            <b className="text-ink-200">대회로 조사된 건 행사 하나가 한 단위</b>입니다 — 대회 전 경기의 프레임을 시간 순으로
            넘겨 맥락을 보고 한 번에 승인합니다. 승인하면 admin 도장이 찍혀 자동 조사가 덮지 못합니다.
            <b className="text-ink-200"> 조사 필요</b>는 검수 대상이 아니라 조사 대상입니다 — 조사는{" "}
            <code>fco-match-context</code> 스킬이 합니다.
          </span>
          <br />
          <span className="mt-1 inline-block">
            <b className="text-ink-200">「방송」 줄</b>은 그 방송에서 처음 본 경기들입니다(경기 하나는 한 줄에만 나옵니다). 누르면 경기마다
            넥슨 기록과 VOD 시점을 칩으로 바꿔 보며 값·맥락을 확인하고 완료합니다. 완료해도 공개되지는 않습니다.
          </span>
        </div>

        {current === "clues" ? (
          <ul className="mt-4 divide-y divide-ink-800">
            {clues.map((c) => (
              <li key={`${c.vod_title_no}:${c.at_sec}`} className="flex flex-wrap items-center gap-3 py-3">
                <a
                  href={`https://vod.sooplive.com/player/${c.vod_title_no}?change_second=${c.at_sec ?? 0}`}
                  target="_blank" rel="noreferrer"
                  className="font-mono text-sm text-ink-200 hover:text-accent-400"
                >
                  VOD {c.vod_title_no} @ {c.at_sec}s ↗
                </a>
                <span className="text-[11px] text-ink-400">{c.channel_id} · {kst(c.observed_at)} KST</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-300">{c.observed}</span>
                <Tag tone="warn">경기 미대조</Tag>
              </li>
            ))}
          </ul>
        ) : visible.length === 0 ? (
          <div className="mt-4"><EmptyState>{EMPTY[current]}</EmptyState></div>
        ) : (
          <ul className="mt-4 divide-y divide-ink-800">
            {visible.map((row) => {
              if (row.type === "screen") {
                const v = row.vod;
                const left = v.total - v.completed;
                return (
                  <li key={`screen:${v.vod}`} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <Link href={`/admin/fco/vod/${v.vod}`} className="block truncate text-sm text-ink-200 hover:text-accent-400">
                        {v.title ?? `VOD ${v.vod}`}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
                        <span>{kst(v.first_at)} KST</span>
                        {v.streamer && <span>{v.streamer}</span>}
                        <span>{v.total}경기</span>
                        {v.api > 0 && <span>넥슨 기록 있음 {v.api}</span>}
                      </div>
                    </div>
                    <span className="flex items-center gap-x-1.5 text-[11px] text-ink-400" title="이 VOD 의 화면 경기 중 사람이 검수를 완료한 수">
                      완료 <b className={left === 0 ? "text-win" : "text-ink-200"}>{v.completed}/{v.total}</b>
                    </span>
                    <Tag tone="neutral">방송</Tag>
                    {left === 0 ? <Tag tone="accent">확인됨</Tag> : <Tag tone="warn">검수 대기 {left}</Tag>}
                  </li>
                );
              }
              const u = row.unit;
              const frames = u.evidences.filter((e) => e.frame_path).length;
              return (
                <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={unitHref(u)} className="block truncate text-sm text-ink-200 hover:text-accent-400">
                      {u.title}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
                      <span>{kst(u.matches[0].played_at)} KST</span>
                      {u.matches.length > 1 && <span>{u.matches.length}경기</span>}
                      {u.judgment && <span className="truncate">{u.judgment.note}</span>}
                    </div>
                  </div>

                  {/* ★ 셋을 분리해 보여준다. 합치면 "프레임 0" 이 "근거 없음" 으로 읽힌다 —
                      조사 전인 것과 조사했는데 프레임이 없는 것은 다르다. */}
                  <span className="flex items-center gap-x-1.5 text-[11px] text-ink-400">
                    <span title="조사가 실제로 열어 근거로 건 프레임">
                      프레임 <b className={frames ? "text-ink-200" : "text-ink-500"}>{frames}</b>
                    </span>
                    <span className="text-ink-600">·</span>
                    <span title="프레임 외 근거 — 공지·채팅·링크">
                      근거 <b className="text-ink-200">{u.evidences.length}</b>
                    </span>
                  </span>

                  <Tag tone={u.status === "event" ? "accent" : u.status === "casual" ? "neutral" : "warn"}>
                    {STATUS_LABEL[u.status]}
                  </Tag>
                  {u.confirmed ? (
                    <Tag tone="accent">확인됨</Tag>
                  ) : u.pending ? (
                    <Tag tone="warn">승인 대기</Tag>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
