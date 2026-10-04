import { ClubParseError } from "./parse.ts";

export interface FcoDivision { name: string; icon: string; order: number }
export interface FcoSeasonGrades { current: FcoDivision | null; previousBest: FcoDivision | null }
// Official /datacenter/rank list_grade, reversed to match update_2026/ico_rank{n}.
const names = ["슈퍼 챔피언스", "챔피언스", "슈퍼 챌린저", "챌린저 1부", "챌린저 2부", "챌린저 3부", "마스터 1부", "마스터 2부", "마스터 3부", "월드클래스 1부", "월드클래스 2부", "월드클래스 3부", "프로 1부", "프로 2부", "프로 3부", "세미프로 1부", "세미프로 2부", "세미프로 3부", "유망주 1부", "유망주 2부", "유망주 3부"];

/** Profile TeamInfo?n1Type=50: previous grade_last is the season peak, NOT its final grade_current. */
export function parseSeasonGrades(html: string): FcoSeasonGrades {
  const current = /class="season_grade_info__current">([\s\S]*?)class="season_grade_info__last">/.exec(html)?.[1];
  const previous = /class="season_grade_info__last">([\s\S]*?)class="season_grade_info__best">/.exec(html)?.[1];
  if (!current || !previous) throw new ClubParseError("공식경기 등급", "시즌별 등급 영역이 없다");
  function grade(section: string, cell: string): FcoDivision | null {
    const body = new RegExp(`class="${cell}">([\\s\\S]*?)</div>`).exec(section)?.[1];
    if (body === undefined) throw new ClubParseError("공식경기 등급", `${cell} 항목이 없다`);
    const icon = /<img[^>]*src="([^"]+)"/.exec(body)?.[1];
    if (!icon && /^(?:\s|—|-)*$/.test(body)) return null;
    const number = /\/rank\/large\/update_2026\/ico_rank(\d+)\.png$/.exec(icon ?? "")?.[1];
    if (number === undefined || !names[Number(number)]) throw new ClubParseError("공식경기 등급", `알 수 없는 등급 아이콘: ${icon}`);
    if (!icon!.startsWith("https://ssl.nexon.com/")) throw new ClubParseError("공식경기 등급", "공식 아이콘이 아니다");
    return { name: names[Number(number)], icon: icon!, order: names.length - Number(number) };
  }
  return { current: grade(current, "grade_current"), previousBest: grade(previous, "grade_last") };
}
