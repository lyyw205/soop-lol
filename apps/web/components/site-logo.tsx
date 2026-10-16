import Image from "next/image";
import styles from "./site-logo.module.css";

/** 입구의 세로형과 같은 심벌을 쓰는 투명 배경 가로형 로고. */
export function SiteLogo({ className = "" }: { className?: string }) {
  return <span className={`${styles.logo} ${className}`}>
    <Image src="/images/brand/soop-seek-horizontal-transparent.png" alt="SOOP SEEK"
      width={2172} height={724} sizes="220px" loading="eager" />
  </span>;
}
