"use client";
import Image from "next/image";
import { useState } from "react";
import logos from "../data/tournament-logos.json" with { type: "json" };

const bySeason = new Map(logos.map((logo) => [logo.eventSlug, logo]));

/** 출처와 시즌을 확인한 원본만 표시한다. 대회명은 호출부에서 항상 함께 제공한다. */
export function TournamentLogo({ slug, className = "", eager = false }: {
  slug: string; className?: string; eager?: boolean;
}) {
  const logo = bySeason.get(slug);
  const [failed, setFailed] = useState<string | null>(null);
  if (!logo || failed === logo.src) return null;
  return <Image className={`tp-event-logo ${className}`} src={logo.src} alt=""
    width={logo.width} height={logo.height}
    sizes={eager ? "(max-width: 580px) 220px, 300px" : "80px"}
    loading={eager ? "eager" : "lazy"} onError={() => setFailed(logo.src)} />;
}
