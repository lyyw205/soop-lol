import { ClubParseError } from "./parse.ts";

export interface FcoTeamColor {
  kind: "club" | "country";
  id: number;
  name: string;
  players: number;
  icon: string;
}
export interface FcoTeamColors {
  source?: "rank-1vs1" | "profile-squad";
  slot?: string | null;
  colors: FcoTeamColor[];
  sourceAt: string;
}
const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();

/** The ranking is last official 1v1, not the currently edited squad. Verify identity
 * before pairing images and names; only official crest/flag asset families qualify. */
export function parseTeamColors(html: string, nickname: string, sn: number): FcoTeamColors {
  if (!html.includes("datacenter_rank_list_1vs1")) throw new ClubParseError("팀컬러", "공식 1대1 랭킹 응답이 아니다");
  const stamp = /※\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*기준/.exec(html)?.[1];
  if (!stamp) throw new ClubParseError("팀컬러", "기준 시각이 없다");
  const sourceAt = stamp.replace(" ", "T") + "+09:00";
  const rows = html.split(/<div class="tr">/).slice(1);
  const identified = rows.flatMap(row => {
    const owner = /<span class="name profile_pointer" data-sn="(\d+)">([^<]*)<\/span>/.exec(row);
    return owner ? [{ row, sn: Number(owner[1]), nickname: text(owner[2]) }] : [];
  });
  const found = identified.find(owner => owner.sn === sn && owner.nickname === nickname);
  if (!found) {
    if (identified.length || !/0명의 구단주|검색 결과가 없습니다|검색된.*없/.test(html)) {
      throw new ClubParseError("팀컬러", "조회 결과의 구단주명·회원번호가 일치하지 않는다");
    }
    return { colors: [], sourceAt };
  }
  const cell = /<span class="td team_color">([\s\S]*?)<span class="td formation">/.exec(found.row)?.[1];
  if (!cell) throw new ClubParseError("팀컬러", "팀컬러 칸이 없다");
  const images = [...cell.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/g)].map(m => m[1]);
  const names = [...cell.matchAll(/<span class="inner">\s*([\s\S]*?)<small>\((\d+)명\)<\/small>/g)];
  if (images.length !== names.length) throw new ClubParseError("팀컬러", "아이콘과 이름 개수가 다르다");
  const colors: FcoTeamColor[] = [];
  for (let i = 0; i < images.length; i++) {
    const icon = images[i];
    const asset = /^https:\/\/fco\.dn\.nexoncdn\.co\.kr\/live\/externalAssets\/common\/(countries\/largeflags\/f_|crests\/light\/medium\/l)(\d+)\.png$/.exec(icon);
    if (!asset) continue; // Enhancement and special/season chemistry are intentionally excluded.
    const name = text(names[i][1]);
    const players = Number(names[i][2]);
    if (!name || players < 1 || players > 11) throw new ClubParseError("팀컬러", "이름 또는 적용 인원이 이상하다");
    const kind = asset[1].startsWith("countries") ? "country" : "club";
    const id = Number(asset[2]);
    if (!colors.some(c => c.kind === kind && c.id === id)) colors.push({ kind, id, name, players, icon });
  }
  return { colors, sourceAt };
}

/** Official profile squad response: affiliation is separate from enhancement/features. */
export function parseSquadTeamColors(body: string): FcoTeamColor[] {
  const raw = JSON.parse(body);
  const affiliation = raw?.totalTeamColor?.affiliation;
  if (!affiliation || typeof affiliation !== "object" || Array.isArray(affiliation)) {
    throw new ClubParseError("프로필 팀컬러", "소속 팀컬러 항목이 없다");
  }
  const colors: FcoTeamColor[] = [];
  for (const value of Object.values(affiliation)) {
    const c = value as { name?: unknown; image?: unknown; playercnt?: unknown };
    if (typeof c.name !== "string" || typeof c.image !== "string" || !Number.isInteger(c.playercnt) || Number(c.playercnt) < 1 || Number(c.playercnt) > 11) {
      throw new ClubParseError("프로필 팀컬러", "이름·이미지·적용 인원이 잘못됐다");
    }
    const asset = /^https:\/\/fco\.dn\.nexoncdn\.co\.kr\/live\/externalAssets\/common\/(countries\/largeflags\/f_|crests\/light\/medium\/l)(\d+)\.png$/.exec(c.image);
    if (!asset) continue;
    colors.push({ kind: asset[1].startsWith("countries") ? "country" : "club", id: Number(asset[2]), name: c.name, players: Number(c.playercnt), icon: c.image });
  }
  return colors;
}
