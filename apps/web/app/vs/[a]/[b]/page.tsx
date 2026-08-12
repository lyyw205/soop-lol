import { notFound } from "next/navigation";

import {
  getStreamerBySlug, getVersus, listVersusRosters, type VersusGame,
} from "@soop-lol/core/lib/db/public";

import { SiteHeader } from "@/components/public";
import { VersusView, type RosterEntry, type VersusSet } from "@/components/versus-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ a: string; b: string }> }) {
  const { a, b } = await params;
  const [x, y] = await Promise.all([getStreamerBySlug(a), getStreamerBySlug(b)]);
  return { title: x && y ? `${x.display_name} vs ${y.display_name} — 상대전적` : "상대전적" };
}

/**
 * 저장된 a/b 를 요청한 x/y 관점으로 뒤집는다. 화면은 "내가 x" 로만 생각한다.
 * (쌍 정규화는 `getVersus` 가 흡수하고 `flip` 으로 알려준다)
 */
function asSeen(g: VersusGame, flip: boolean): VersusSet {
  const [xw, yw] = flip ? [g.b_win, g.a_win] : [g.a_win, g.b_win];
  const [xp, yp] = flip ? [g.b_position, g.a_position] : [g.a_position, g.b_position];
  const xs = flip
    ? { k: g.b_kills, d: g.b_deaths, a: g.b_assists }
    : { k: g.a_kills, d: g.a_deaths, a: g.a_assists };
  const ys = flip
    ? { k: g.a_kills, d: g.a_deaths, a: g.a_assists }
    : { k: g.b_kills, d: g.b_deaths, a: g.b_assists };
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
    // ★ Date 가 아니라 ISO 문자열로 넘긴다. 서버→클라이언트 경계에서 Date 는
    //   직렬화 규칙에 기대게 되는데, 여기서 필요한 건 '연·월·일' 뿐이라 문자열이 확실하다.
    played_at: g.game_creation.toISOString(),
    xWin: xw, yWin: yw,
    xPos: xp, yPos: yp,
    xK: xs.k, xD: xs.d, xA: xs.a,
    yK: ys.k, yD: ys.d, yA: ys.a,
  };
}

export default async function VersusPage({ params }: { params: Promise<{ a: string; b: string }> }) {
  const { a: slugX, b: slugY } = await params;
  const [x, y] = await Promise.all([getStreamerBySlug(slugX), getStreamerBySlug(slugY)]);
  if (!x || !y) notFound();
  if (x.streamer_id === y.streamer_id) notFound();

  // ★ 한 쌍의 조우는 많아야 수십 건이다. 한 번에 다 주고 필터·집계는 화면에서 한다 —
  //   관계·연도·정렬을 바꿀 때마다 서버를 왕복하면 느리기만 하고 얻는 게 없다.
  const { flip, games } = await getVersus(x.streamer_id, y.streamer_id);
  const sets = games.map((g) => asSeen(g, flip));
  const rosters = (await listVersusRosters(sets.map((s) => s.match_id))) as RosterEntry[];

  const bare = { slug: x.slug, display_name: x.display_name, streamer_id: x.streamer_id };
  const bareY = { slug: y.slug, display_name: y.display_name, streamer_id: y.streamer_id };

  return (
    <>
      <SiteHeader />
      {sets.length === 0 ? (
        <main className="mx-auto box-border w-full max-w-[1120px] px-6 py-16">
          <h1 className="text-[22px] font-semibold text-ink-200">
            {x.display_name} <span className="font-normal text-ink-400">vs</span> {y.display_name}
          </h1>
          <p className="mt-6 rounded-xl border border-dashed border-ink-700 px-[18px] py-[34px] text-center text-[13px] text-ink-400">
            아직 두 사람이 같은 경기에서 만난 기록이 없습니다.
          </p>
        </main>
      ) : (
        <VersusView x={bare} y={bareY} sets={sets} rosters={rosters} />
      )}
    </>
  );
}
