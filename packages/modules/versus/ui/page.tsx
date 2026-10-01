/**
 * 상대전적 모듈 UI. 주소 하나(module.json)가 두 화면을 맡는다 —
 * 아무것도 안 고르면 **선택기 + 많이 붙은 쌍**, 둘을 고르면 **상세**.
 *
 * ★ 왜 경로 하나인가
 *   두 사람은 경로 칸이 아니라 쿼리스트링 `?a=&b=` 로 받는다 — 순서 바꾸기·필터가
 *   전부 같은 주소의 쿼리만 바꾸면 되고, 공유한 링크가 그대로 같은 화면을 연다.
 *
 * ★ 계산은 여기서, 사실은 코어에서
 *   조우(누가 같은 경기에 있었나)는 코어가 수집·파생한 사실이다. 이 모듈은 그걸
 *   읽어 "맞대결이 몇 대 몇인가" 를 해석해 그린다. 같은 것을 두 군데서 만들지 않는다.
 */

import {
  getPublicStreamer, listEncountersBetween, listMatchRosters, listPublicStreamerOptions,
  type PublicEncounter, isMatchCategoryFilter, resolveRecordPeriod,
} from "@soop-lol/core/lib/contract";

import { VersusDetail, type VersusSet } from "./detail.tsx";
import { VersusPicker } from "./picker.tsx";
import { TopPairs } from "./top-pairs.tsx";
import { topPairs } from "../server/index.ts";
import { ProfileSidebar } from "./sidebar.tsx";
import { RecordLayout } from "../../../ui/record-layout.tsx";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** 저장된 a/b 를 요청한 x/y 관점으로 뒤집는다. 화면은 "내가 x" 로만 생각한다. */
function asSeen(g: PublicEncounter, flip: boolean): VersusSet {
  // 계약은 outcome 만 준다. 화면 내부의 boolean 은 여기서 파생되는 표시값일 뿐이다.
  const [xo, yo] = flip ? [g.b_outcome, g.a_outcome] : [g.a_outcome, g.b_outcome];
  const [xp, yp] = flip ? [g.b_position, g.a_position] : [g.a_position, g.b_position];
  const xs = flip ? [g.b_kills, g.b_deaths, g.b_assists] : [g.a_kills, g.a_deaths, g.a_assists];
  const ys = flip ? [g.a_kills, g.a_deaths, g.a_assists] : [g.b_kills, g.b_deaths, g.b_assists];
  return {
    match_id: g.match_id,
    series_key: g.series_key,
    series_game_no: g.series_game_no,
    best_of: g.best_of,
    set_order_known: g.set_order_known,
    source: g.source,
    category: g.category,
    queue_id: g.queue_id,
    event_name: g.event_name,
    relation: g.relation,
    is_lane_matchup: g.is_lane_matchup,
    // Date 가 아니라 ISO 문자열로 넘긴다 — 서버→클라이언트 경계에서 확실하다.
    played_at: new Date(g.game_creation).toISOString(),
    xWin: xo === "win", yWin: yo === "win",
    xPos: xp, yPos: yp,
    xK: xs[0], xD: xs[1], xA: xs[2],
    yK: ys[0], yD: ys[1], yA: ys[2],
  };
}

export default async function VersusModulePage(
  { searchParams }: { searchParams: Record<string, string | string[] | undefined> },
) {
  const categoryInput = one(searchParams.category);
  const category = categoryInput && isMatchCategoryFilter(categoryInput) ? categoryInput : "all";
  const relation = one(searchParams.relation) === "ally" ? "a" : one(searchParams.relation) === "lane" ? "l" : "o";
  const datePeriod = resolveRecordPeriod({from:one(searchParams.from),to:one(searchParams.to)});
  const yearInput = one(searchParams.year);
  const year = yearInput && /^\d{4}$/.test(yearInput) ? Number(yearInput) : undefined;
  let aSlug = one(searchParams.a)?.trim();
  let bSlug = one(searchParams.b)?.trim();
  // 홈과 모듈 첫 화면에서는 기록이 가장 많은 실제 쌍을 먼저 보여준다.
  if (!aSlug && !bSlug) {
    const [featured] = await topPairs(1);
    aSlug = featured?.a_slug;
    bSlug = featured?.b_slug;
  }

  const [x, y] = await Promise.all([
    aSlug ? getPublicStreamer(aSlug) : null,
    bSlug ? getPublicStreamer(bSlug) : null,
  ]);

  // ── 둘 다 고르지 않았으면 선택 화면 ──
  if (!x || !y || x.streamer_id === y.streamer_id) {
    const options = await listPublicStreamerOptions();
    const notFound = [aSlug && !x ? aSlug : null, bSlug && !y ? bSlug : null].filter(Boolean) as string[];
    return (
      <RecordLayout sidebar={x ? <ProfileSidebar person={x} /> : <aside className="arena-rail"><section className="arena-panel"><h2>스트리머 정보</h2><p className="text-xs text-ink-400">스트리머를 선택하면 프로필과 수상 경력을 함께 볼 수 있습니다.</p></section><TopPairs /></aside>}>
        <VersusPicker options={options} a={x?.slug} b={y?.slug} category={category} year={year} />
        {x && y && x.streamer_id === y.streamer_id && (
          <p className="mt-2 text-[11px] text-amber-300">같은 사람 둘을 고를 수는 없습니다.</p>
        )}
        {notFound.length > 0 && (
          <p className="mt-2 text-[11px] text-amber-300">
            찾지 못했습니다: {notFound.join(", ")} — 목록에서 골라 주세요.
          </p>
        )}
      </RecordLayout>
    );
  }

  // ── 상세 ──
  const raw = await listEncountersBetween(x.streamer_id, y.streamer_id);
  // 계약이 쌍 정규화(a < b)를 흡수하므로, 요청한 x 가 저장된 a 인지만 보면 된다.
  const flip = [x.streamer_id, y.streamer_id].sort()[0] !== x.streamer_id;
  const sets = raw.map((g) => asSeen(g, flip));
  const rosters = await listMatchRosters(sets.map((s) => s.match_id));

  const options = await listPublicStreamerOptions();


  return (
    <RecordLayout sidebar={<ProfileSidebar person={x} exclude={[x.slug, y.slug]} />}>
      <VersusDetail key={`detail-${x.slug}-${y.slug}-${category}-${year ?? "all"}-${relation}-${datePeriod.from ?? ""}-${datePeriod.to ?? ""}`} x={x} y={y} sets={sets} rosters={rosters} options={options} initialCategory={category} initialYear={year} initialRelation={relation} initialDatePeriod={datePeriod} />
    </RecordLayout>
  );
}
