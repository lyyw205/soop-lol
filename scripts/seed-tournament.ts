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
  saveEventTeams,
  saveTournamentGame,
  streamerIdsBySlug,
  upsertEvent,
} from "@soop-lol/core/lib/db/tournaments";
import { championByName } from "@soop-lol/core/lib/riot/champions";
import { POSITIONS } from "@soop-lol/core/lib/riot/types";
import { placementRank } from "@soop-lol/core/lib/metrics/placement";

interface SeedLineupEntry {
  slug: string;
  position?: string;
  /**
   * ★ 결과 화면에 적힌 **한글 이름 그대로** 적는다 (`쓰레쉬` · `자르반 4세` · `미스 포츈`).
   *   띄어쓰기는 안 맞아도 된다. 모르는 이름이면 여기서 거부한다 —
   *   ID 를 사람이 옮겨 적으면 조용히 다른 챔피언 전적이 된다(§11-2).
   */
  champion?: string;
  /** 이름 대신 ID 를 직접 적어도 된다. 둘 다 있으면 champion 이 이긴다. */
  champion_id?: number;
  /**
   * ★ 그 판에서 쓴 **인게임 계정이 등록된 계정과 다를 때** 그 이름을 적는다.
   *
   *   내전은 부계정으로 자주 한다. 그런데 slug 만 적으면 그 사람의 **대표 puuid**
   *   가 붙어서, **뛰지도 않은 계정에 경기가 달린다.**
   *   실제로 겪었다 — 2026-07-01 강만식CK 에서 영재애애의 인게임명은 `영 재` 였는데
   *   등록 계정 `YoungDisney#KR111` 의 전적으로 들어갔다. 그 계정의 챔피언 통계가
   *   조용히 오염된다. `puuid` 가 유일한 키라는 §11-1 이 무너지는 자리다.
   *
   *   이걸 적으면 puuid 를 **비우고** `streamer_id` 로만 넣는다. "이 사람이 이 판에
   *   있었다" 는 사실은 지키고, "이 계정이 뛰었다" 는 거짓은 안 만든다.
   *   나중에 그 계정을 근거와 함께 등록하면 재파생으로 이어 붙일 수 있다.
   */
  unlinked_account?: string;
  /** 결과 화면의 K/D/A. 모르면 비운다. */
  kills?: number;
  deaths?: number;
  assists?: number;
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
  /**
   * ★ 이 경기의 승패를 확정한 **결과 화면** 지점. VOD 시각(`1:05:00`)이나
   *   프레임 파일명(`lshooooo_203787373_f1_10500.jpg`).
   *
   *   `kind: "scrim"` 대회(=방송을 읽어 넣는 내전)에는 **필수**다.
   *   채팅 `!공지` 만 믿었다가 실제로 승자가 뒤집혔다 — 2026-08-08 시그니처CK
   *   2부 3세트에서 공지 두 개가 27초 사이로 서로 다른 승자를 말했고, 먼저 온
   *   오기를 채택해 사이트에 잘못 올라갔다. 공지는 **어디를 볼지 알려주는 단서**고,
   *   정본은 LoL 최종 결과 화면이다. 그걸 봤다는 사실을 여기 남긴다.
   */
  result_evidence?: string;
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
  /**
   * 팀명 → 순위 표기 (우승 / 준우승 / 4강 / 2차예선 탈락 …). 출처가 쓴 그대로 넣는다.
   * 모르는 팀은 아예 없다 — 순위를 지어내지 않는다.
   */
  team_placements?: Record<string, string>;
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
    // 로스터를 한 명도 못 붙인 대회도 넣는다. 경기가 있었던 건 사실이고,
    // 나중에 명단을 알게 되면 다시 돌려 조우를 살릴 수 있다(§11-5).
    // 다만 화면에 아무것도 안 나오므로 눈에 띄게 알린다.
    if (emptyTeams.length === teamNames.size && teamNames.size > 0) {
      warnings.push(`${at}: 팀 ${teamNames.size}개 전부 로스터를 못 붙였다 — 경기만 들어가고 조우는 0이다`);
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
      // ★ 결과 화면 확인은 선택이 아니라 **마지막 필수 관문**이다.
      //   내전 승패의 정본은 방송의 LoL 최종 결과 화면뿐이다.
      //   (주최측이 발표하는 대회 kind='tournament' 는 발표문이 원천이라 해당 없다)
      if (t.kind === "scrim" && !g.result_evidence?.trim()) {
        errors.push(`${gat}: result_evidence 가 없다 — 내전은 결과 화면을 확인해야 넣는다`
          + ` (예: "1:05:00" · 프레임 파일명). 채팅 공지는 단서일 뿐이다`);
      }
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
          // ★ 못 읽은 챔피언 이름을 조용히 넘기면 champion_id 가 0(='모른다')으로
          //   들어가 판독이 실패한 사실 자체가 사라진다. 여기서 멈춘다.
          if (e.champion && championByName(e.champion) === null) {
            errors.push(`${gat}: 챔피언 '${e.champion}' 을 못 찾았다 — 결과 화면의 한글 이름 그대로 적어라`
              + ` (표가 낡았으면 npm run build:champions)`);
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
/** 명단에 아예 없는 사람. 이게 곧 **내가 SOOP 에서 찾아 등록할 목록**이다. */
const unknownPeople = new Set<string>();

try {
  for (const t of list) {
    console.log(`\n▸ ${t.name} (${t.slug})${dryRun ? "  [dry-run]" : ""}`);

    // ★ 두 가지를 구분한다. 예전엔 한 덩어리로 "계정 없음" 이라 불러서,
    //   **아예 등록조차 안 된 사람**이 조용히 빠지는 걸 못 봤다.
    //     · 등록됨 + 계정 없음  → 경기·조우에는 들어간다(0017). 나중에 계정만 붙이면 된다
    //     · 등록조차 안 됨      → 어디에도 못 들어간다. **여기서 멈춰야 한다**
    const allSlugs = [...new Set(Object.values(t.teams).flat())];
    const [puuidBySlug, knownIds] = await Promise.all([
      mainPuuidsBySlug(allSlugs), streamerIdsBySlug(allSlugs),
    ]);
    const unregistered = allSlugs.filter((s) => !knownIds.has(s));
    for (const s of allSlugs) if (knownIds.has(s) && !puuidBySlug.has(s)) missing.add(s);
    for (const s of unregistered) unknownPeople.add(`${s}  (${t.name})`);

    console.log(`  팀 ${Object.keys(t.teams).length} · 선수 ${allSlugs.length}명 ` +
      `(계정 있음 ${puuidBySlug.size} / 등록만 ${knownIds.size - puuidBySlug.size} / 미등록 ${unregistered.length})`);

    if (dryRun) {
      for (const g of t.games ?? []) {
        console.log(`  경기 ${g.id}  ${g.blue} vs ${g.red} → ${g.winner} 승`
          + `  (결과화면 ${g.result_evidence ?? "-"})`);
      }
      games += (t.games ?? []).length;
      continue;
    }

    const eventId = await upsertEvent(t);

    // 팀 명단을 대회 단위로 저장한다. 계정이 없는 스트리머도 팀 명단에는 들어간다 —
    // 조우는 못 맺어도 "그 대회에 그 팀으로 나갔다" 는 사실은 맞기 때문이다.
    const idBySlug = await streamerIdsBySlug(allSlugs);
    const teamIdByName = await saveEventTeams(
      eventId,
      Object.entries(t.teams).map(([name, roster]) => ({
        name,
        placement: t.team_placements?.[name] ?? null,
        placement_rank: placementRank(t.team_placements?.[name]),
        members: roster
          .filter((slug) => idBySlug.has(slug))
          .map((slug) => ({ streamer_id: idBySlug.get(slug)!, position: t.roster_positions?.[slug] })),
      })),
    );
    console.log(`  팀 ${teamIdByName.size}개 명단 저장`);

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
          // ★ 계정이 없어도 **경기에는 넣는다.** 우리가 아는 사실은 "이 사람이 이 판에
          //   있었다" 지 "이 계정이 있었다" 가 아니다. 예전엔 여기서 건너뛰어서
          //   이라333 이 시그니처CK 5경기에서 통째로 사라졌다 — 팀·포지션·챔피언·KDA 를
          //   결과 화면에서 다 읽어 놓고도 화면에는 성훈팀이 4명으로 나왔다.
          // ★ 인게임 계정이 등록 계정과 다르면 puuid 를 붙이지 않는다.
          //   안 그러면 안 뛴 계정에 경기가 달라붙는다(SeedLineupEntry.unlinked_account 주석).
          const puuid = e.unlinked_account ? null : (puuidBySlug.get(e.slug) ?? null);
          const streamerId = idBySlug.get(e.slug) ?? null;
          if (!puuid && !streamerId) continue;   // 등록조차 안 된 사람은 넣을 수 없다
          const champ = e.champion ? championByName(e.champion) : null;
          participants.push({
            puuid, streamer_id: streamerId, team_id: teamId,
            // ★ 포지션은 lineup 이 안 적었으면 대회 로스터 포지션으로 메운다.
            //   lineup 을 쓰는 순간 roster_positions 가 통째로 무시돼서
            //   맞라인 판정이 조용히 사라졌다(§11-10 은 '틀린 맞라인' 이 없느니만
            //   못하다고 하지, 있는 걸 버리라는 뜻이 아니다).
            position: e.position ?? t.roster_positions?.[e.slug] ?? null,
            champion_id: champ?.id ?? e.champion_id ?? null,
            champion_name: champ?.en ?? null,
            kills: e.kills ?? null,
            deaths: e.deaths ?? null,
            assists: e.assists ?? null,
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
        result_evidence: g.result_evidence?.trim() || null,
        series_id: g.series ? `${t.slug}:${g.series}` : null,
        series_game_no: g.series ? (g.set_no ?? null) : null,
        blue_team_id: teamIdByName.get(g.blue) ?? null,
        red_team_id: teamIdByName.get(g.red) ?? null,
        winning_team: g.winner === g.blue ? 100 : 200,
        participants,
      });
      matchIds.push(matchId);
      games++;
      console.log(`  경기 ${g.id}  ${g.blue} vs ${g.red} → ${g.winner} 승  (참가자 ${participants.length}`
        + `${g.result_evidence ? ` · 결과화면 ${g.result_evidence}` : ""})`);
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
  // ★ 미등록은 **경고가 아니라 실패**다.
  //   빠진 채로 들어가면 그 경기의 로스터가 영영 한 명 모자란 채 굳는다.
  //   실제로 이라333 이 그렇게 다섯 경기에서 사라져 있었고, 화면을 보고서야 알았다.
  if (unknownPeople.size > 0) {
    console.error(`\n명단에 없는 사람 ${unknownPeople.size}명이다. 등록하기 전에는 넣지 않는다:\n`);
    for (const p of unknownPeople) console.error(`  ✖ ${p}`);
    console.error(`\nSOOP 에서 찾아 등록한 뒤 다시 돌려라:`);
    console.error(`  1. https://sch.sooplive.co.kr 에서 방송국을 찾는다 (또는 나에게 이름을 주면 찾아 준다)`);
    console.error(`  2. seed/streamers-*.json 에 slug·display_name·channel_id 로 적는다`);
    console.error(`  3. npm run seed -- seed/streamers-*.json`);
    console.error(`\n★ 라이엇 계정은 없어도 된다 — 등록만 되면 경기·조우·모스트 챔피언에 다 들어간다.`);
    process.exitCode = 1;
  } else if (missing.size > 0) {
    console.log(
      `\n· 라이엇 계정이 아직 없는 스트리머 ${missing.size}명: ${[...missing].join(", ")}\n` +
        `  경기·조우·모스트 챔피언에는 **들어갔다** (0017 — 사람으로 식별한다).\n` +
        `  계정을 연결하면 공개 큐 전적까지 이어 붙는다.`,
    );
  }
} catch (e) {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
