import logos from "../data/team-logos.json" with { type: "json" };

const normalize = (name: string) => name.replace(/\s+/gu, "").toLowerCase();
const paths = new Map(logos.map((logo) => [`${logo.eventSlug}:${normalize(logo.team)}`, logo.src]));

/** 같은 이름의 다른 시즌 팀에 로고를 빌려 쓰지 않는다. */
export function teamLogoPath(eventSlug: string, teamName: string): string | null {
  return paths.get(`${eventSlug}:${normalize(teamName)}`) ?? null;
}
