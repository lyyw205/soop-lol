import { ClubParseError } from "./parse.ts";

export interface ValueRankingEntry { sn: number; nickname: string; rank: number; value: number }
export interface ValueRanking { day: string; entries: ValueRankingEntry[] }
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/** Only the official club-value section, never match-win or ELO rankings. A partial
 * TOP 50 must fail rather than incorrectly marking absent accounts as unlisted. */
export function parseValueRanking(html: string): ValueRanking {
  const dateInput = html.match(/<input\b[^>]*id="strDate"[^>]*>/)?.[0];
  const date = dateInput?.match(/value="(\d{4})\.(\d{2})\.(\d{2})"/);
  if (!date) throw new ClubParseError("공식 구단가치 순위", "기준 날짜가 없다");
  const day = `${date[1]}-${date[2]}-${date[3]}`;
  if (new Date(day).toISOString().slice(0, 10) !== day) throw new ClubParseError("공식 구단가치 순위", "기준 날짜가 잘못됐다");
  const section = html.split('<div id="rankValue"')[1]?.split('<div id="')[0];
  if (!section) throw new ClubParseError("공식 구단가치 순위", "구단가치 순위 영역이 없다");
  const entries = section.split('<div class="item_list swiper-slide">').slice(1).map(row => {
    const owner = /class="name profile_pointer" data-sn="(\d+)">\s*([^<]+)/.exec(row);
    const rank = /class="rank rank_bp">\s*<span>(\d+)위/.exec(row);
    const price = /class="value" alt="([\d,]+)"/.exec(row);
    if (!owner || !rank || !price) throw new ClubParseError("공식 구단가치 순위", "순위 행의 필수 값이 없다");
    const entry = { sn: Number(owner[1]), nickname: decode(owner[2]), rank: Number(rank[1]), value: Number(price[1].replaceAll(',', '')) };
    if (!Number.isSafeInteger(entry.sn) || !Number.isSafeInteger(entry.value) || entry.value < 0 || !entry.nickname) throw new ClubParseError("공식 구단가치 순위", "잘못된 계정 또는 가치");
    return entry;
  });
  if (entries.length !== 50 || new Set(entries.map(e => e.sn)).size !== 50 || entries.some((e, i) => e.rank !== i + 1)) {
    throw new ClubParseError("공식 구단가치 순위", "완전한 TOP 50이 아니다");
  }
  return { day, entries };
}
