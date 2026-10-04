import { ClubParseError } from "./parse.ts";

export interface FcoRating { score: number | null; sourceAt: string }

/** Current official 1v1 ELO. Empty search is distinct from a failed/changed response. */
export function parseRating(html: string, nickname: string, sn: number): FcoRating {
  if (!html.includes("datacenter_rank_list_1vs1")) throw new ClubParseError("공식경기 점수", "공식 1대1 응답이 아니다");
  const stamp = /※\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*기준/.exec(html)?.[1];
  if (!stamp) throw new ClubParseError("공식경기 점수", "기준 시각이 없다");
  const sourceAt = stamp.replace(" ", "T") + "+09:00";
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
  const rows = html.split(/<div class="tr">/).slice(1);
  let owners = 0;
  for (const row of rows) {
    const owner = /<span class="name profile_pointer" data-sn="(\d+)">([^<]*)<\/span>/.exec(row);
    if (!owner) continue;
    owners++;
    if (Number(owner[1]) !== sn || decode(owner[2]) !== nickname) continue;
    const value = /<span class="td rank_r_win_point">\s*([\d,]+(?:\.\d+)?)\s*<\/span>/.exec(row)?.[1];
    if (!value || !Number.isFinite(Number(value.replaceAll(",", "")))) throw new ClubParseError("공식경기 점수", "점수가 없다");
    return { score: Number(value.replaceAll(",", "")), sourceAt };
  }
  if (owners || !/0명의 구단주|검색 결과가 없습니다|검색된.*없/.test(html)) throw new ClubParseError("공식경기 점수", "구단주명·회원번호가 일치하지 않는다");
  return { score: null, sourceAt };
}
