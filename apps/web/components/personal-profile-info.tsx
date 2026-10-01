import Link from "next/link";
import { RecordAwards, RecordChampions, type RecordAward, type RecordChampion } from "../../../packages/ui/record-profile-info";

/**
 * 개인 프로필 카드의 아래 절반.
 *
 * ★ 예전엔 여기 '방송 채널' 과 '게임 계정' 칸이 더 있었다. 둘 다 카드 머리(이름 줄)로
 *   올라갔다 — 계정 닉네임은 이름 위, 방송 채널은 이름 아래. 같은 것을 두 군데 두는 대신
 *   비워진 자리를 **모스트 챔피언이 넓게 쓴다**(3개 → 5개).
 */
export function PersonalProfileInfo({ slug, champions, awards, placements }: {
  slug: string; champions: RecordChampion[]; awards: RecordAward[];
  placements: { total: number; buckets: { key: string; count: number }[]; exhibition: { champion: number; runnerup: number } };
}) {
  // 올스타전·이벤트 매치 우승은 정규 우승 숫자에 섞지 않고 따로 적는다(0052).
  const ex = placements.exhibition;
  const exText = ex.champion + ex.runnerup > 0
    ? ` (올스타·이벤트전 ${[ex.champion ? `우승 ${ex.champion}` : "", ex.runnerup ? `준우승 ${ex.runnerup}` : ""].filter(Boolean).join(" · ")} 별도)` : "";
  // These panels describe the whole career, independent of the record filters.
  const eventsHref = `/s/${slug}?tab=events`;
  return <>
    <section className="profile-most profile-info-section">
      <h3>모스트 챔피언 <small>통산</small></h3>
      <RecordChampions champions={champions} href={`/s/${slug}?tab=champions`} layout="profile" />
    </section>
    <section className="profile-career profile-info-section">
      <h3>수상 경력 <small>통산</small></h3>
      <RecordAwards awards={awards} href={eventsHref} layout="profile" />
      <Link className="profile-career-link" href={eventsHref}>
        우승 {placements.buckets.find((b) => b.key === "champion")?.count ?? 0} · 준우승 {placements.buckets.find((b) => b.key === "runnerup")?.count ?? 0}{exText} · 참가 {placements.total}회 →
      </Link>
    </section>
  </>;
}
