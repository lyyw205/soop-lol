"use client";

import Link from "next/link";
import { profileHref as personHref } from "@soop-lol/core/lib/contract";

import { Avatar } from "../../../ui/avatar.tsx";

export interface FixturePerson { slug: string; display_name: string; profile_image_url?: string | null; channel_id?: string | null }

export function Portrait({ person }: { person: FixturePerson }) {
  return <Avatar name={person.display_name} src={person.profile_image_url} channelId={person.channel_id} />;
}

/**
 * @param badge 원 테두리 위에 붙는 작은 칩. 상대전적에서 **어느 쪽이 기준인가**를 말한다 —
 *   예전엔 이름 아래에 '왼쪽 스트리머' / '오른쪽 스트리머' 라고 적었는데, 화면을 보면
 *   이미 아는 사실이라 자리만 먹었다. 정작 필요한 건 "숫자가 누구 기준인가" 하나다.
 */
export function FixturePersonView({ person, badge, linked = false, profileHref }: { person: FixturePerson; badge?: string; linked?: boolean; profileHref?: string }) {
  return <div className="arena-person">
    <span className="arena-disc">{badge && <em className="arena-person-badge">{badge}</em>}<Portrait person={person} /></span>
    {linked ? <Link className="arena-person-name" href={profileHref ?? personHref("lol", person.slug)}>{person.display_name}</Link> : <span className="arena-person-name">{person.display_name}</span>}
  </div>;
}
