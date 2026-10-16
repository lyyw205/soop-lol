/**
 * 상대전적 모듈 UI. 주소 하나(module.json)가 두 화면을 맡는다 —
 * 아무것도 안 고르면 **빈 선택기**, 둘을 고르면 **상세**.
 *
 * ★ 왜 경로 하나인가
 *   두 사람은 경로 칸이 아니라 쿼리스트링 `?a=&b=` 로 받는다 — 순서 바꾸기·필터가
 *   전부 같은 주소의 쿼리만 바꾸면 되고, 공유한 링크가 그대로 같은 화면을 연다.
 *
 * ★ 사실과 세기는 코어에서
 *   "누가 같은 판에 있었나" 는 코어의 공개 내전 세트(versus_pair_set)이고, 세트·시리즈를 세는 규칙은 코어의 tally 다.
 *   이 모듈은 그것으로 고르고 그린다. 같은 것을 두 군데서 만들지 않는다.
 */

import {
  getPublicStreamer, listPairSetsBetween, listMatchRosters, listPublicStreamerOptions, readRecordScope,
} from "@soop-lol/core/lib/contract";

import { VersusDetail } from "./detail.tsx";
import { VersusPicker } from "./picker.tsx";
import { ProfileSidebar } from "./sidebar.tsx";
import { RecordLayout } from "../../../ui/record-layout.tsx";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function VersusModulePage(
  { searchParams }: { searchParams: Record<string, string | string[] | undefined> },
) {
  const query = new URLSearchParams();
  for (const [key,value] of Object.entries(searchParams)) {
    const v = one(value); if (v !== undefined) query.set(key,v);
  }
  const {map, format, period} = readRecordScope(query);
  const year = period.key === "year" && period.from ? Number(period.from.slice(0,4)) : undefined;
  // 홈과 모듈 첫 화면은 빈 선택기로 연다. 사용자가 지정한 a/b만 선택한다.
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
      <RecordLayout sidebar={x ? <ProfileSidebar person={x} /> : <aside className="arena-rail"><section className="arena-panel"><h2>스트리머 정보</h2><p className="text-xs text-ink-400">스트리머를 선택하면 프로필과 수상 경력을 함께 볼 수 있습니다.</p></section></aside>}>
        <VersusPicker options={options} a={x?.slug} b={y?.slug} scope={{ map, format, year }} />
        {x && y && x.streamer_id === y.streamer_id && (
          <p className="mt-2 text-[length:var(--type-micro)] text-amber-300">같은 사람 둘을 고를 수는 없습니다.</p>
        )}
        {notFound.length > 0 && (
          <p className="mt-2 text-[length:var(--type-micro)] text-amber-300">
            찾지 못했습니다: {notFound.join(", ")} — 목록에서 골라 주세요.
          </p>
        )}
      </RecordLayout>
    );
  }

  // ── 상세 ── 두 사람 사이의 공개 세트 전부(x 기준). 맵·진행 방식·관계·기간은 화면이 고른다 — 세는 규칙은 코어의 tally.
  const sets = await listPairSetsBetween(x.streamer_id, y.streamer_id);
  const rosters = await listMatchRosters(sets.map((s) => s.match_id));

  const options = await listPublicStreamerOptions();


  return (
    <RecordLayout sidebar={<ProfileSidebar person={x} exclude={[x.slug, y.slug]} />}>
      <VersusDetail key={`detail-${x.slug}-${y.slug}`} x={x} y={y} sets={sets} rosters={rosters} options={options} />
    </RecordLayout>
  );
}
