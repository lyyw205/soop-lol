"use client";
import { useState } from "react";
import Image from "next/image";
import { teamLogoPath } from "./team-logo-path.ts";

/** 팀명은 옆에 따로 표시한다. 로고가 없거나 로드되지 않으면 가짜 문양을 만들지 않는다. */
export function TeamLogo({ eventSlug, name, className = "tp-team-badge" }: {
  eventSlug: string; name: string; className?: string;
}) {
  const src = teamLogoPath(eventSlug, name);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) return null;
  return <span className={`${className} tp-team-logo`} aria-hidden="true">
    <Image src={src} alt="" width={82} height={82} sizes="82px" onError={() => setFailedSrc(src)} />
  </span>;
}
