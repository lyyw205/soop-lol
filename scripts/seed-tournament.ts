/**
 * 대회 기록 적재.
 *
 *   npm run seed:tournament -- seed/tournaments.json --dry-run
 *   npm run seed:tournament -- seed/tournaments.json
 *
 * 멸망전 같은 내전은 Riot API 로 조회할 수 없다. 주최측이 발표한 것이 유일한 원천이므로
 * **손으로 만든 JSON** 을 넣는다. 형식은 seed/tournaments.example.json.
 *
 * ★ 근거(source_url)가 없으면 거부한다. 대회 결과도 "누가 누구를 이겼나" 라서,
 *   근거 없는 전적을 만들지 않는다는 원칙(§11-2)이 계정 매핑과 똑같이 적용된다.
 *
 * 같은 파일을 다시 돌려도 안전하다(멱등).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closeDb } from "@soop-lol/core/lib/db/client";
import { rederiveEncounters } from "@soop-lol/core/lib/db/ingest";
import {
  listEventGames,
  mainPuuidsBySlug,
  pruneEventMatches,
  saveTournamentGame,
  upsertEvent,
} from "@soop-lol/core/lib/db/tournaments";
import { POSITIONS } from "@soop-lol/core/lib/riot/types";

interface SeedLineupEntry {
  slug: string;
  position?: string;
  champion_id?: number;
}

interface SeedGame {
  id: string;
  round?: string;
  /**
   * 다전제라면 그 시리즈 키와 몇 번째 세트인지. 같은 `series` 를 가진 경기들이
   * 한 '경기(매치)'가 된다. 단판이면 비운다.
   * 왜 필요한가: 3판 2선승을 2:1 로 이기면 세트로는 2승 1패, 매치로는 1승 0패다.
   * 둘은 다른 사실이라 둘 다 셀 수 있어야 한다 (마이그레이션 0007).
   */
  series?: string;
  set_no?: number;
  played_at: string;
  blue: string;
  red: string;
  winner: string;
  duration?: number;
  source_url?: string;
  lineup?: Record<string, SeedLineupEntry[]>;
}

interface SeedTournament {
  slug: string;
  name: string;
  kind?: "scrim" | "tournament" | "showmatch" | "other";
  organizer?: string;
  starts_at?: string;
  ends_at?: string;
  source_url?: string;
  teams: Record<string, string[]>;
  /**
   * slug → 로스터 포지션. 경기마다 lineup 을 적지 않아도 이걸로 포지션이 붙는다.
   * ★ 없으면 대회 맞라인 전적이 통째로 안 생긴다 — 상대 5명 전부와 조우가 맺히는데
   *   그중 '같은 라인 1:1' 은 포지션을 알아야 가려낼 수 있다.
   *   대회 포지션은 Riot 추론값이 아니라 주최측이 발표한 로스터라 오히려 단단하다.
   *   다만 '그 판의 실제 포지션' 이 아니라 '로스터상 포지션' 이다.
   */
  roster_positions?: Record<string, string>;
  games?: SeedGame[];
}

// ── 검증 ─────────────────────────────────────────────────────────────

const warnings: string[] = [];

function validate(list: SeedTournament[]): string[] {
  const errors: string[] = [];
  const positions = new Set<string>(POSITIONS);

  for (const [i, t] of list.entries()) {
    const at = `[${i}] ${t.slug ?? t.name ?? "(이름 없음)"}`;
    if (!t.slug) errors.push(`${at}: slug 가 없다`);
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(t.slug)) errors.push(`${at}: slug 는 소문자·숫자·하이픈만`);
    if (!t.name) errors.push(`${at}: name 이 없다`);
    // ★ 이 검사가 이 스크립트의 존재 이유다.
    if (!t.source_url) errors.push(`${at}: source_url 이 없다 — 근거 없는 대회 기록은 만들지 않는다`);
    if (!t.teams || Object.keys(t.teams).length === 0) errors.push(`${at}: teams 가 비었다`);

    const teamNames = new Set(Object.keys(t.teams ?? {}));
    const emptyTeams: string[] = [];
    for (const [name, roster] of Object.entries(t.teams ?? {})) {
      if (!Array.isArray(roster)) errors.push(`${at} 팀 '${name}': 로스터가 배열이 아니다`);
      else if (roster.length === 0) emptyTeams.push(name);
    }
    // ★ 로스터가 빈 팀은 오류가 아니다. 그 팀이 대회에 나온 건 사실인데 선수를
    //   한 명도 우리 스트리머로 매핑하지 못한 것뿐이다(옛 닉네임이라 해석 실패 등).
    //   경기는 그대로 넣는다 — 상대 팀 안에서 '같은 팀' 조우는 여전히 성립하고,
    //   나중에 그 팀 선수의 계정이 붙으면 재파생으로 상대전적이 되살아난다(§11-5).
    if (emptyTeams.length === teamNames.size && teamNames.size > 0) {
      errors.push(`${at}: 모든 팀의 로스터가 비었다 — 넣을 게 없다`);
    } else if (emptyTeams.length > 0) {
      warnings.push(`${at}: 선수를 한 명도 매핑하지 못한 팀 ${emptyTeams.length}개 — ${emptyTeams.join(", ")}`);
    }

    for (const [slug, pos] of Object.entries(t.roster_positions ?? {})) {
      if (!positions.has(pos)) {
        errors.push(`${at}: roster_positions['${slug}'] = '${pos}' 은 ${[...positions].join("/")} 중 하나여야 한다`);
      }
    }

    const gameIds = new Set<string>();
    for (const [j, g] of (t.games ?? []).entries()) {
      const gat = `${at} 경기[${j}]${g.id ? ` ${g.id}` : ""}`;
      if (!g.id) errors.push(`${gat}: id 가 없다`);
      else if (gameIds.has(g.id)) errors.push(`${gat}: id 가 대회 안에서 중복이다`);
      else gameIds.add(g.id);

      if (g.series && !(typeof g.set_no === "number" && g.set_no >= 1)) {
        errors.push(`${gat}: series 를 적었으면 set_no(1부터)도 있어야 한다 — 한쪽만 있으면 집계가 조용히 틀어진다`);
      }
      if (!g.series && g.set_no !== undefined) {
        errors.push(`${gat}: set_no 만 있고 series 가 없다`);
      }
      if (!g.played_at || Number.isNaN(Date.parse(g.played_at))) {
        errors.push(`${gat}: played_at 이 없거나 날짜 형식이 아니다`);
      }
      for (const side of ["blue", "red"] as const) {
        if (!g[side]) errors.push(`${gat}: ${side} 팀이 없다`);
        else if (!teamNames.has(g[side])) errors.push(`${gat}: ${side} 팀 '${g[side]}' 이 teams 에 없다`);
      }
      if (g.blue && g.red && g.blue === g.red) errors.push(`${gat}: 같은 팀끼리 붙을 수 없다`);
      if (!g.winner) errors.push(`${gat}: winner 가 없다`);
      else if (g.winner !== g.blue && g.winner !== g.red) {
        errors.push(`${gat}: winner '${g.winner}' 가 blue/red 중 하나가 아니다`);
      }

      for (const [team, entries] of Object.entries(g.lineup ?? {})) {
        if (!teamNames.has(team)) errors.push(`${gat}: lineup 의 팀 '${team}' 이 teams 에 없다`);
        for (const e of entries) {
          if (!e.slug) errors.push(`${gat}: lineup 항목에 slug 가 없다`);
          if (e.position && !positions.has(e.position)) {
            errors.push(`${gat}: 포지션 '${e.position}' 은 ${[...positions].join("/")} 중 하나여야 한다`);
          }
        }
      }
    }
  }
  return errors;
}

// ── 실행 ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--")) ?? "seed/tournaments.json";

let list: SeedTournament[];
try {
  list = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
} catch (e) {
  console.error(`대회 파일을 읽지 못했다: ${file}\n  ${e instanceof Error ? e.message : String(e)}`);
  console.error(`형식은 seed/tournaments.example.json 참고.`);
  process.exit(1);
}
if (!Array.isArray(list)) {
  console.error("최상위가 배열이어야 한다.");
  process.exit(1);
}

const errors = validate(list);
if (errors.length > 0) {
  console.error(`\n입력이 잘못됐다 (${errors.length}건). 아무것도 넣지 않았다:\n`);
  for (const e of errors) console.error(`  ✖ ${e}`);
  process.exit(1);
}

for (const w of warnings) console.warn(`  ⚠ ${w}`);

let games = 0;
let encounters = 0;
const missing = new Set<string>();

try {
  for (const t of list) {
    console.log(`\n▸ ${t.name} (${t.slug})${dryRun ? "  [dry-run]" : ""}`);

    // slug → puuid. 계정이 없는 스트리머는 조우를 맺을 수 없다(조우는 puuid 로 맺힌다).
    const allSlugs = [...new Set(Object.values(t.teams).flat())];
    const puuidBySlug = await mainPuuidsBySlug(allSlugs);
    for (const s of allSlugs) if (!puuidBySlug.has(s)) missing.add(s);

    console.log(`  팀 ${Object.keys(t.teams).length} · 선수 ${allSlugs.length}명 ` +
      `(계정 있음 ${puuidBySlug.size} / 없음 ${allSlugs.length - puuidBySlug.size})`);

    if (dryRun) {
      for (const g of t.games ?? []) {
        console.log(`  경기 ${g.id}  ${g.blue} vs ${g.red} → ${g.winner} 승  (${g.round ?? "-"})`);
      }
      games += (t.games ?? []).length;
      continue;
    }

    const eventId = await upsertEvent(t);
    const matchIds: string[] = [];

    for (const g of t.games ?? []) {
      const sides = [
        { team: g.blue, teamId: 100 as const },
        { team: g.red, teamId: 200 as const },
      ];
      const participants: Parameters<typeof saveTournamentGame>[0]["participants"] = [];

      for (const { team, teamId } of sides) {
        // lineup 이 있으면 그걸 쓰고, 없으면 팀 로스터 전원.
        const entries: SeedLineupEntry[] =
          g.lineup?.[team] ??
          (t.teams[team] ?? []).map((slug) => ({ slug, position: t.roster_positions?.[slug] }));
        for (const e of entries) {
          const puuid = puuidBySlug.get(e.slug);
          if (!puuid) continue; // 계정 없는 스트리머는 건너뛴다 — 위에서 집계해 보고한다
          participants.push({
            puuid, team_id: teamId,
            position: e.position ?? null,
            champion_id: e.champion_id ?? null,
          });
        }
      }

      const matchId = `${t.slug}:${g.id}`;
      await saveTournamentGame({
        match_id: matchId,
        event_id: eventId,
        played_at: new Date(g.played_at),
        duration: g.duration ?? null,
        source_url: g.source_url ?? t.source_url ?? null,
        series_id: g.series ? `${t.slug}:${g.series}` : null,
        series_game_no: g.series ? (g.set_no ?? null) : null,
        winning_team: g.winner === g.blue ? 100 : 200,
        participants,
      });
      matchIds.push(matchId);
      games++;
      console.log(`  경기 ${g.id}  ${g.blue} vs ${g.red} → ${g.winner} 승  (참가자 ${participants.length})`);
    }

    // ★ 시드 파일이 이 대회의 전부다. 이전에 넣었다가 이번 파일엔 없는 경기는 지운다.
    //   안 그러면 경기 단위를 바꿨을 때(시리즈 → 세트) 낡은 행이 남아 두 배로 잡힌다.
    const pruned = await pruneEventMatches(eventId, matchIds);
    if (pruned > 0) console.log(`  이번 시드에 없는 낡은 경기 ${pruned}건을 지웠다`);

    // 조우 파생. 공개 큐와 같은 경로를 쓴다 — 대회를 위한 별도 계보를 만들지 않는다.
    if (matchIds.length > 0) {
      encounters += await rederiveEncounters(matchIds);
    }
    const saved = await listEventGames(t.slug);
    console.log(`  → 대회에 저장된 경기 ${saved.length}건`);
  }

  console.log(`\n경기 ${games}건 · 조우 ${encounters}쌍${dryRun ? "  (dry-run — 쓰지 않았다)" : ""}`);
  if (missing.size > 0) {
    console.log(
      `\n⚠ 라이엇 계정이 없어 조우에 못 들어간 스트리머 ${missing.size}명: ${[...missing].join(", ")}\n` +
        `  계정을 연결하고 이 스크립트를 다시 돌리면 그 사람의 대회 조우가 되살아난다.`,
    );
  }
} catch (e) {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
