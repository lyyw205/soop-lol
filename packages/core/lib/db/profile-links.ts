import { db } from "./client.ts";
import { profileGameFor, profileHref, type NavigationSite, type SiteGame } from "../site-paths.ts";

export async function publicProfileLinks(slugs: string[], game: string | null, site: NavigationSite): Promise<Map<string,string>> {
  if (!slugs.length) return new Map();
  const rows = await db()<{slug: string; lol: boolean; fconline: boolean}[]>`
    SELECT s.slug,
      EXISTS(SELECT 1 FROM core_public.streamer_match m WHERE m.streamer_id = s.streamer_id) AS lol,
      EXISTS(SELECT 1 FROM streamer_fco_account a WHERE a.streamer_id = s.streamer_id AND a.visibility = 'public') AS fconline
    FROM core_public.streamer s WHERE s.slug = ANY(${slugs})`;
  return new Map(rows.map(r => {
    const available: SiteGame[] = [...(r.lol ? ["lol" as const] : []), ...(r.fconline ? ["fconline" as const] : [])];
    return [r.slug, profileHref(profileGameFor(available, game === "lol" || game === "fconline" ? game : null, site), r.slug)];
  }));
}
