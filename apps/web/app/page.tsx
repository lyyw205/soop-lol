import Link from "next/link";
import { streamersHref } from "@soop-lol/core/lib/site-paths";
import { moduleProviding } from "@soop-lol/modules/registry";
import { moduleUi } from "@soop-lol/modules/ui";
import { countPublic } from "@soop-lol/core/lib/db/public";
import { PageShell, SiteHeader } from "@/components/public";
import { roleHref } from "@/lib/module-links";

export const dynamic = "force-dynamic";

/** 홈의 상대전적도 등록부를 통해 마운트한다. 모듈 제거 시 인물 탐색으로 연결한다. */
export default async function Home() {
  const counts = await countPublic();
  const mod = moduleProviding("versus");
  const load = mod ? moduleUi(mod.name) : undefined;
  const View = load ? (await load()).default : null;
  return <>
    <SiteHeader />
    <PageShell>
      {View ? <View params={{}} searchParams={{}} roleHref={roleHref} /> : <div className="arena-title"><div><h1>스트리머 기록실</h1><p>스트리머의 경기와 수상 경력을 만나보세요.</p><Link href={streamersHref()}>스트리머 찾아보기 →</Link></div></div>}
      <div className="arena-counts"><span>스트리머<b>{counts.streamers.toLocaleString()}명</b></span><span>수집 경기<b>{counts.matches.toLocaleString()}</b></span><span>조우<b>{counts.encounters.toLocaleString()}</b></span></div>
    </PageShell>
  </>;
}
