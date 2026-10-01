import Link from "next/link";

import { countFcoPublic } from "@soop-lol/core/lib/db/fconline";
import { countPublic } from "@soop-lol/core/lib/db/public";
import { gameHomeHref } from "@soop-lol/core/lib/site-paths";

import { PageShell, SiteHeader } from "@/components/public";

export const dynamic = "force-dynamic";

/**
 * 로비 — 게임과 무관한 공간의 첫 화면(docs/PLATFORM-LAYER-PLAN.md).
 *
 * ★ 숫자는 **게임별로** 쓴다. 롤 경기·조우는 롤 전용 공개 뷰에서 세고, FC 경기는 FC 공개 조건으로 센다.
 *   게임마다 "경기"의 단위가 달라(롤 세트 ↔ FC 한 판) 더한 숫자는 뜻이 없다 — 합계를 내지 않는다.
 * ★ 카드 밖 숫자는 사람 수 하나다. core_public.streamer 는 게임으로 거르지 않는 명부라,
 *   게임별 인원의 합이 아니라 숨기지 않은 **사람** 수다.
 */
export default async function Lobby() {
  const [lol, fc] = await Promise.all([countPublic(), countFcoPublic()]);
  const games = [
    { href: gameHomeHref("lol"), name: "리그 오브 레전드", tag: "LOL",
      stats: [["수집 경기", lol.matches], ["스트리머 조우", lol.encounters]] as const },
    { href: gameHomeHref("fconline"), name: "FC 온라인", tag: "FC",
      stats: [["수집 경기", fc.matches], ["기록 있는 스트리머", fc.people]] as const },
  ];
  return <>
    <SiteHeader site="platform" />
    <PageShell>
      <div className="arena-title"><div>
        <h1>스트리머 기록실</h1>
        <p>SOOP 스트리머끼리 누가 누구를 이겼는지 모아 봅니다. 등록 스트리머 <b>{lol.streamers.toLocaleString()}명</b></p>
      </div></div>
      <div className="lobby-games">
        {games.map((g) => <Link key={g.tag} href={g.href} className="arena-panel lobby-game">
          <span className="lobby-game-tag">{g.tag}</span>
          <h2>{g.name}</h2>
          <dl>{g.stats.map(([label, n]) => <div key={label}><dt>{label}</dt><dd>{n.toLocaleString()}</dd></div>)}</dl>
          <span className="lobby-game-go">기록 보기 →</span>
        </Link>)}
      </div>
    </PageShell>
  </>;
}
