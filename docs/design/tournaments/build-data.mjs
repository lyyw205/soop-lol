/** Read-only design fixture: local seeds -> a portable, public-field-only snapshot. No DB writes. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, "seed", name), "utf8"));
const people = {};
for (const file of fs
  .readdirSync(path.join(root, "seed"))
  .filter((f) => /^streamers.*\.json$/.test(f) && !f.includes("example"))) {
  const rows = read(file);
  if (!Array.isArray(rows)) continue;
  for (const p of rows)
    if (p.slug)
      people[p.slug] = { slug: p.slug, name: p.display_name || p.slug };
}
for (const p of read("streamers.json"))
  people[p.slug] = { slug: p.slug, name: p.display_name || p.slug };
const files = fs
  .readdirSync(path.join(root, "seed"))
  .filter((f) => /^tournaments-meljang-.*\.json$/.test(f));
files.push(
  "tournaments-junggangye-2026-viper.json",
  "tournaments-ck-2026-08-13-mg.json",
  "tournaments-ck-2026-08-08.json",
);
const events = files
  .flatMap((file) =>
    read(file).map((e) => {
      const groups = Object.groupBy(e.games || [], (g) => g.series || g.id);
      const series = Object.entries(groups).map(([id, games]) => {
        const a = games[0].blue,
          b = games[0].red;
        const sets = games.map((g) => ({
          id: g.id,
          no: g.set_no ?? null,
          winner: g.winner,
          blue: g.blue,
          red: g.red,
          duration: g.duration ?? null,
          source: g.source_url || e.source_url,
          lineup: g.lineup
            ? Object.fromEntries(
                Object.entries(g.lineup).map(([team, ps]) => [
                  team,
                  ps.map((p) =>
                    Object.fromEntries(
                      [
                        "slug",
                        "observed_name",
                        "position",
                        "champion",
                        "kills",
                        "deaths",
                        "assists",
                      ]
                        .filter((k) => p[k] != null)
                        .map((k) => [k, p[k]]),
                    ),
                  ),
                ]),
              )
            : null,
        }));
        return {
          id,
          round: games[0].round?.replace(/\s+\d세트$/, "") || "경기",
          date: games[0].played_at?.slice(0, 10),
          a,
          b,
          sa: sets.filter((g) => g.winner === a).length,
          sb: sets.filter((g) => g.winner === b).length,
          orderKnown: e.set_order_known === true,
          sets,
        };
      });
      return {
        slug: e.slug,
        name: e.name,
        start: e.starts_at?.slice(0, 10),
        end: e.ends_at?.slice(0, 10),
        organizer: e.organizer,
        source: e.source_url,
        category:
          e.kind === "ck" || /allstar/.test(e.slug)
            ? "event"
            : /meljang/.test(e.slug)
              ? "meljang"
              : "invitational",
        kind: e.kind,
        teams: e.teams || {},
        placements: e.team_placements || {},
        positions: e.roster_positions || {},
        series,
      };
    }),
  )
  .sort((a, b) => (b.start || "").localeCompare(a.start || ""));
// Champion map is only used to render verified picks; splash art elsewhere is decorative.
const champions = JSON.parse(
  fs.readFileSync(
    path.join(root, "packages/core/lib/riot/champions.ko.json"),
    "utf8",
  ),
);
const data = { asOf: "2026-09-25", events, people, champions };
fs.writeFileSync(
  path.join(root, "apps/web/public/design-lab/tournaments/data.js"),
  `export const data = ${JSON.stringify(data)};\n`,
);
console.log(
  `${events.length} events, ${events.reduce((s, e) => s + e.series.length, 0)} series exported; no database changes.`,
);
