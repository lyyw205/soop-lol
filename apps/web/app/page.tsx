import type { Metadata } from "next";
import Link from "next/link";
import { gameHomeHref, recordSearchHref } from "@soop-lol/core/lib/site-paths";
import { EntranceMotion } from "./entrance-motion";
import styles from "./entrance.module.css";

export const metadata: Metadata = {
  title: { absolute: "SOOP SEEK · 스트리머 기록실" },
  description: "SOOP 스트리머의 FC온라인·리그 오브 레전드 전적, 구단가치, CK·대회 기록을 만나보세요.",
};

const games = [
  {
    id: "fc", href: gameHomeHref("fconline"), label: "FC온라인 메인으로 이동", cta: "메인으로",
    object: "football-cutout.webp", logo: "fc-online-logo-white.png", logoAlt: "EA SPORTS FC ONLINE",
    logoWidth: 364, logoHeight: 52, features: ["상대 전적", "구단가치", "CK·대회"],
  },
  {
    id: "lol", href: recordSearchHref("lol"), label: "리그 오브 레전드 전적 검색", cta: "전적 검색",
    object: "crystal-cutout.webp", logo: "league-of-legends-logo-gold.svg", logoAlt: "리그 오브 레전드",
    logoWidth: 735.87, logoHeight: 287.4, features: ["상대 전적", "챔피언 기록", "CK·대회"],
  },
] as const;

/** Game selection only: keep this entrance independent of record/database queries. */
export default function Lobby() {
  return <main className={styles.entrance} aria-label="게임 선택">
    <div className={styles.stage}>
      <EntranceMotion className={styles.games}>
        {games.map((game) => <Link key={game.id} href={game.href} className={`${styles.game} ${styles[game.id]}`}
          aria-label={game.label} data-entrance-game={game.id}>
          <div className={styles.atmosphere} aria-hidden="true" />
          <div className={styles.orbits} aria-hidden="true"><i /></div>
          <div className={styles.objectStage} aria-hidden="true">
            <img className={styles.object} src={`/images/entrance/${game.object}`} alt="" width={1448} height={1086} fetchPriority="high" />
          </div>
          <div className={styles.particles} aria-hidden="true"><i /><i /><i /><i /></div>
          <div className={styles.info}>
            <h2 className={styles.gameTitle}>
              <img className={styles.wordmark} src={`/images/entrance/${game.logo}`} width={game.logoWidth} height={game.logoHeight} alt={game.logoAlt} />
            </h2>
            <ul className={styles.features} aria-label={`${game.logoAlt} 주요 기능`}>
              {game.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
            <div className={styles.cta}><span>{game.cta}</span><span className={styles.arrow} aria-hidden="true">↗</span></div>
          </div>
          <div className={styles.pointerLight} aria-hidden="true" />
        </Link>)}
      </EntranceMotion>
      <header className={styles.brand} aria-label="SOOP SEEK">
        <div className={styles.halo} aria-hidden="true" />
        <div className={styles.brandSlot}>
          <h1 className={styles.brandLogo}><img src="/images/brand/soop-seek-stacked-transparent.png" alt="SOOP SEEK" width={1254} height={1254} fetchPriority="high" /></h1>
        </div>
        <p className={styles.description}><strong>SOOP 스트리머 기록실</strong><span>전적부터 CK·대회까지</span></p>
      </header>
    </div>
  </main>;
}
