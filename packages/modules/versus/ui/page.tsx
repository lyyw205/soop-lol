/**
 * 상대전적 모듈 UI. `/m/versus` 하나가 두 화면을 맡는다 —
 * 아무것도 안 고르면 **선택기 + 많이 붙은 쌍**, 둘을 고르면 **상세**.
 *
 * ★ 왜 경로 하나인가
 *   host 는 모듈마다 `/m/<name>` 한 자리만 내준다. 모듈이 경로를 더 파려면
 *   core 가 그 모듈 이름을 알아야 하는데 그게 역방향 의존이다(계약 4조).
 *   대신 host 가 쿼리스트링을 그대로 넘겨 주므로 `?a=&b=` 로 대상을 받는다.
 *
 * ★ 계산은 여기서, 사실은 코어에서
 *   조우(누가 같은 경기에 있었나)는 코어가 수집·파생한 사실이다. 이 모듈은 그걸
 *   읽어 "맞대결이 몇 대 몇인가" 를 해석해 그린다. 같은 것을 두 군데서 만들지 않는다.
 */

import {
  getPublicStreamer, listEncountersBetween, listMatchRosters, listPublicStreamerOptions,
  type PublicEncounter,
} from "@soop-lol/core/lib/contract";

import { VersusDetail, type RosterEntry, type VersusSet } from "./detail.tsx";
import { VersusPicker } from "./picker.tsx";
import { TopPairs } from "./top-pairs.tsx";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** 저장된 a/b 를 요청한 x/y 관점으로 뒤집는다. 화면은 "내가 x" 로만 생각한다. */
function asSeen(g: PublicEncounter, flip: boolean): VersusSet {
  const [xw, yw] = flip ? [g.b_win, g.a_win] : [g.a_win, g.b_win];
  const [xp, yp] = flip ? [g.b_position, g.a_position] : [g.a_position, g.b_position];
  const xs = flip ? [g.b_kills, g.b_deaths, g.b_assists] : [g.a_kills, g.a_deaths, g.a_assists];
  const ys = flip ? [g.a_kills, g.a_deaths, g.a_assists] : [g.b_kills, g.b_deaths, g.b_assists];
  return {
    match_id: g.match_id,
    series_key: g.series_key,
    series_game_no: g.series_game_no,
    source: g.source,
    category: g.category,
    queue_id: g.queue_id,
    event_name: g.event_name,
    relation: g.relation,
    is_lane_matchup: g.is_lane_matchup,
    // Date 가 아니라 ISO 문자열로 넘긴다 — 서버→클라이언트 경계에서 확실하다.
    played_at: new Date(g.game_creation).toISOString(),
    xWin: xw, yWin: yw,
    xPos: xp, yPos: yp,
    xK: xs[0], xD: xs[1], xA: xs[2],
    yK: ys[0], yD: ys[1], yA: ys[2],
  };
}

export default async function VersusModulePage(
  { searchParams }: { searchParams: Record<string, string | string[] | undefined> },
) {
  const aSlug = one(searchParams.a)?.trim();
  const bSlug = one(searchParams.b)?.trim();

  const [x, y] = await Promise.all([
    aSlug ? getPublicStreamer(aSlug) : null,
    bSlug ? getPublicStreamer(bSlug) : null,
  ]);

  // ── 둘 다 고르지 않았으면 선택 화면 ──
  if (!x || !y || x.streamer_id === y.streamer_id) {
    const options = await listPublicStreamerOptions();
    const notFound = [aSlug && !x ? aSlug : null, bSlug && !y ? bSlug : null].filter(Boolean) as string[];
    return (
      <>
        <h1 className="text-2xl font-semibold text-ink-100">상대전적</h1>
        <p className="mt-2 text-sm text-ink-400">
          두 사람을 고르면 <strong className="text-ink-200">맞붙었을 때</strong>와{" "}
          <strong className="text-ink-200">같은 팀이었을 때</strong>를 나눠서 보여줍니다.
          같은 라인에서 1:1로 만난 판은 따로 셉니다.
        </p>
        <VersusPicker options={options} a={x?.slug} b={y?.slug} />
        {x && y && x.streamer_id === y.streamer_id && (
          <p className="mt-2 text-[11px] text-amber-300">같은 사람 둘을 고를 수는 없습니다.</p>
        )}
        {notFound.length > 0 && (
          <p className="mt-2 text-[11px] text-amber-300">
            찾지 못했습니다: {notFound.join(", ")} — 목록에서 골라 주세요.
          </p>
        )}
        <TopPairs />
      </>
    );
  }

  // ── 상세 ──
  const raw = await listEncountersBetween(x.streamer_id, y.streamer_id);
  // 계약이 쌍 정규화(a < b)를 흡수하므로, 요청한 x 가 저장된 a 인지만 보면 된다.
  const flip = [x.streamer_id, y.streamer_id].sort()[0] !== x.streamer_id;
  const sets = raw.map((g) => asSeen(g, flip));
  const rosters = (await listMatchRosters(sets.map((s) => s.match_id))) as RosterEntry[];

  if (sets.length === 0) {
    return (
      <>
        <h1 className="text-[22px] font-semibold text-ink-200">
          {x.display_name} <span className="font-normal text-ink-400">vs</span> {y.display_name}
        </h1>
        <p className="mt-6 rounded-xl border border-dashed border-ink-700 px-[18px] py-[34px] text-center text-[13px] text-ink-400">
          아직 두 사람이 같은 경기에서 만난 기록이 없습니다.
        </p>
      </>
    );
  }

  return (
    <VersusDetail
      x={{ slug: x.slug, display_name: x.display_name, streamer_id: x.streamer_id }}
      y={{ slug: y.slug, display_name: y.display_name, streamer_id: y.streamer_id }}
      sets={sets}
      rosters={rosters}
    />
  );
}
