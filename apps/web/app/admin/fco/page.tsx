import Link from "next/link";

import { getFcoReviewWorkspace, listFcoCrossClues, type FcoReviewUnit } from "@soop-lol/core/lib/games/fconline/context";
import { listFcoSessions, type FcoSession } from "@soop-lol/core/lib/games/fconline/sessions";

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
 * 목록의 한 줄 — **경기 하나는 한 줄에만** 나온다.
 *   대회   행사에 붙은 경기들 → /admin/fco/event-<id>
 *   대전   누가 누구와 한 자리에서 연달아 한 경기 묶음(core/games/fconline/sessions.ts) → /admin/fco/session/<id>
 *          방송(VOD)은 단위가 아니라 경기의 시점이다 — 방송 단위로 검수하면 같은 경기를 방송마다 다시 본다(2026-10-02).
 * 거르기: ?who=<스트리머 slug>(뛰었거나 그 사람 방송에 나온 것) · ?vod=<VOD 번호>(그 방송에 나온 것)
 */
type Row = { type: "unit"; unit: FcoReviewUnit } | { type: "session"; s: FcoSession };

const EMPTY: Record<string, string> = {
  pending: "승인 대기 중인 조사가 없습니다.",
  confirmed: "아직 승인한 단위가 없습니다.",
  todo: "조사가 필요한 경기가 없습니다.",
  all: "공개 스트리머 간 FC 경기가 없습니다. 수집은 `npm run worker -- fco` 가 합니다.",
  clues: "LoL 조사가 남긴 FC 화면 단서가 없습니다.",
  casual: "일반 유저와 한 경기가 없습니다.",
};

export default async function FcoReviewListPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; who?: string; vod?: string }>;
}) {
  const { view = "pending", who, vod } = await searchParams;
  const [allUnits, clues, sessions] = await Promise.all([getFcoReviewWorkspace(), listFcoCrossClues(), listFcoSessions()]);
  // 대회 단위만 그대로 쓴다. 대회 밖 경기는 전부 대전으로 들어간다(경기 하나 = 한 줄).
  const events = allUnits.filter((u) => u.kind === "event")
    .filter((u) => !who || u.matches.some((m) => m.participants.some((p) => p.slug === who)))
    .filter((u) => !vod || u.evidences.some((e) => String(e.vod_title_no) === vod));
  const shown = sessions
    .filter((x) => !who || x.people.some((p) => p.slug === who))
    .filter((x) => !vod || x.vods.includes(vod));
  const people = [...new Map(sessions.flatMap((x) => x.people).map((p) => [p.slug, p.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  const unitRows = (list: FcoReviewUnit[]): Row[] => list.map((unit) => ({ type: "unit", unit }));
  const sessionRows = (list: FcoSession[]): Row[] => list.map((x) => ({ type: "session", s: x }));
  // ★ 맥락(친선·CK·대회)을 가르는 검수는 스트리머 vs 스트리머 대전만 한다. 일반 유저전(스트리머 vs 일반 유저, 닉네임끼리)은
  //   CK·대회일 일이 없어 값(스코어·결과 화면)만 보고 완료하면 된다 — 기본 탭에서 빼고 「일반 유저전」 탭에 따로 모은다.
  const versus = shown.filter((x) => x.kind === "pair");
  const casual = shown.filter((x) => x.kind !== "pair");
  const groups: Record<string, Row[]> = {
    pending: [...unitRows(events.filter((u) => u.pending)), ...sessionRows(versus.filter((x) => x.investigated && x.completed < x.total))],
    confirmed: [...unitRows(events.filter((u) => u.confirmed)), ...sessionRows(versus.filter((x) => x.completed === x.total))],
    todo: sessionRows(versus.filter((x) => !x.investigated && x.completed < x.total)),
    all: [...unitRows(events), ...sessionRows(versus)],
    // 일반 유저전 — 남은 것 먼저, 그다음 완료한 것
    casual: sessionRows([...casual.filter((x) => x.completed < x.total), ...casual.filter((x) => x.completed === x.total)]),
  };
  const qs = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ view, who, vod, ...patch })) if (v) q.set(k, v);
    return `/admin/fco?${q}`;
  };
  const TABS = [
    { key: "pending", label: "검수 대기" },
    { key: "confirmed", label: "확인됨" },
    { key: "todo", label: "조사 필요" },
    { key: "all", label: "전체" },
    { key: "casual", label: "일반 유저전" },
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
              href={qs({ view: t.key })}
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

        <form action="/admin/fco" className="mb-4 flex flex-wrap items-center gap-2 text-xs text-ink-400">
          <input type="hidden" name="view" value={current} />
          스트리머
          <select name="who" defaultValue={who ?? ""} className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-200">
            <option value="">전체</option>
            {people.map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
          </select>
          방송 번호
          <input name="vod" defaultValue={vod ?? ""} placeholder="VOD 번호" inputMode="numeric" className="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-200" />
          <button type="submit" className="rounded border border-ink-700 px-2 py-1 text-ink-200 hover:border-accent-400">거르기</button>
          {(who || vod) && <a href={qs({ who: undefined, vod: undefined })} className="text-ink-400 hover:text-ink-200">거르기 해제</a>}
          <span className="text-ink-500">— 그 사람이 뛰었거나 그 사람 방송에 나온 대전, 그 방송에 나온 대전</span>
        </form>

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
            <b className="text-ink-200">「대전」 줄</b>은 누가 누구와 한 자리에서 연달아 한 경기 묶음입니다(경기 하나는 한 줄에만 나옵니다).
            누르면 경기마다 넥슨 기록과 그 경기를 본 방송들을 칩으로 바꿔 보고, 맥락은 대전 전체에 한 번에 정할 수 있습니다. 완료해도 공개되지는 않습니다.
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
              if (row.type === "session") {
                const x = row.s;
                const left = x.total - x.completed;
                return (
                  <li key={x.id} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <Link href={`/admin/fco/session/${encodeURIComponent(x.id)}`} className="block truncate text-sm text-ink-200 hover:text-accent-400">
                        {x.title}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
                        <span>{kst(x.from)}{x.total > 1 ? ` ~ ${kst(x.to).split(" ").slice(-1)[0]}` : ""} KST</span>
                        <span>{x.total}판</span>
                        {x.api > 0 && <span>넥슨 기록 {x.api}</span>}
                        {x.vods.length > 0 && <span>본 방송 {x.vods.length}</span>}
                      </div>
                    </div>
                    <span className="flex items-center gap-x-1.5 text-[11px] text-ink-400" title="이 대전의 경기 중 사람이 검수를 완료한 수">
                      완료 <b className={left === 0 ? "text-win" : "text-ink-200"}>{x.completed}/{x.total}</b>
                    </span>
                    <Tag tone="neutral">{x.kind === "pair" ? "대전" : x.kind === "solo" ? "일반 유저전" : "닉네임 대전"}</Tag>
                    {left === 0 ? <Tag tone="accent">확인됨</Tag> : x.investigated ? <Tag tone="warn">검수 대기 {left}</Tag> : <Tag tone="neutral">조사 필요</Tag>}
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
