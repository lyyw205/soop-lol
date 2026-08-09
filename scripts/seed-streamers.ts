/**
 * 시드 스트리머 등록.
 *
 *   npm run seed -- seed/streamers.json --dry-run   # 무엇이 바뀔지만 본다
 *   npm run seed -- seed/streamers.json             # 실제로 넣는다
 *
 * ★ 명단은 **손으로 만든다**. 타 사이트를 긁어오지 않는다 (docs/PLAN.md §11-9).
 *   ToS 위반이고 Riot Production Key 심사에서도 감점이다.
 *
 * ★ 계정 매핑에는 **근거가 반드시 있어야 한다** (§11-2).
 *   evidence.url 이나 evidence.note 가 비면 여기서 거부한다 — linkAccount 가
 *   한 번 더 막지만, 파일 단위로 먼저 걸러야 "어디가 틀렸는지"를 알 수 있다.
 *   부계정 오노출은 실제 분쟁이 된다.
 *
 * 같은 파일을 다시 돌려도 안전하다(멱등). slug 가 이미 있으면 갱신한다.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closeDb } from "@soop-lol/core/lib/db/client";
import { ensureBackfillCursor } from "@soop-lol/core/lib/db/ingest";
import {
  createStreamer,
  getStreamer,
  linkAccount,
  updateStreamer,
  upsertRiotAccount,
} from "@soop-lol/core/lib/db/streamers";
import type { AccountEvidence, Confidence, Platform } from "@soop-lol/core/lib/db/types";
import { RiotApiError, RiotClient } from "@soop-lol/core/lib/riot/client";

interface SeedAccount {
  /** `닉네임#태그`. RIOT_API_KEY 가 있으면 이걸로 puuid 를 찾는다. */
  riot_id?: string;
  /** riot_id 대신 puuid 를 직접 적어도 된다 (키가 없을 때). */
  puuid?: string;
  label?: string;
  is_main?: boolean;
  confidence?: Confidence;
  /** ★ url 또는 note 중 하나는 반드시 있어야 한다. */
  evidence: AccountEvidence;
}

interface SeedStreamer {
  slug: string;
  display_name: string;
  platform?: Platform;
  platform_user_id?: string;
  channel_url?: string;
  aliases?: string[];
  is_pro?: boolean;
  team_name?: string;
  note?: string;
  accounts?: SeedAccount[];
}

// ── 입력 검증 ────────────────────────────────────────────────────────

function validate(list: SeedStreamer[]): string[] {
  const errors: string[] = [];
  const slugs = new Set<string>();

  list.forEach((s, i) => {
    const at = `[${i}] ${s.slug ?? s.display_name ?? "(이름 없음)"}`;
    if (!s.slug) errors.push(`${at}: slug 가 없다`);
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(s.slug)) errors.push(`${at}: slug 는 소문자·숫자·하이픈만 (URL 에 쓴다)`);
    else if (slugs.has(s.slug)) errors.push(`${at}: slug 가 파일 안에서 중복이다`);
    else slugs.add(s.slug);

    if (!s.display_name) errors.push(`${at}: display_name 이 없다`);

    for (const [j, a] of (s.accounts ?? []).entries()) {
      const aat = `${at} 계정[${j}]`;
      if (!a.riot_id && !a.puuid) errors.push(`${aat}: riot_id 또는 puuid 가 있어야 한다`);
      if (a.riot_id && !a.riot_id.includes("#")) errors.push(`${aat}: riot_id 는 '닉네임#태그' 형식이다`);
      if (a.puuid && a.puuid.length !== 78) errors.push(`${aat}: puuid 는 78자다 (지금 ${a.puuid.length}자)`);
      // ★ 이 검사가 이 스크립트의 존재 이유다.
      if (!a.evidence?.url && !a.evidence?.note) {
        errors.push(`${aat}: 근거(evidence.url 또는 evidence.note)가 없다 — 근거 없는 매핑은 만들지 않는다`);
      }
    }
  });

  return errors;
}

// ── 실행 ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--")) ?? "seed/streamers.json";

const path = resolve(process.cwd(), file);
let list: SeedStreamer[];
try {
  list = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`명단을 읽지 못했다: ${path}\n  ${e instanceof Error ? e.message : String(e)}`);
  console.error(`\n형식은 seed/streamers.example.json 을 참고할 것.`);
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

const needsLookup = list.some((s) => (s.accounts ?? []).some((a) => a.riot_id && !a.puuid));
const apiKey = process.env.RIOT_API_KEY;
if (needsLookup && !apiKey) {
  console.error("riot_id 로 puuid 를 찾으려면 RIOT_API_KEY 가 필요하다. 키 없이 가려면 puuid 를 직접 적을 것.");
  process.exit(1);
}
const riot = apiKey ? new RiotClient({ apiKey }) : null;

console.log(`\n▸ ${file} — 스트리머 ${list.length}명${dryRun ? "  (dry-run: 아무것도 쓰지 않는다)" : ""}\n`);

let created = 0;
let updated = 0;
let linked = 0;
let failed = 0;

try {
  for (const s of list) {
    const existing = await getStreamer(s.slug);
    const label = `${s.display_name} (${s.slug})`;

    let streamerId: string;
    if (existing) {
      streamerId = existing.id;
      if (!dryRun) {
        await updateStreamer(existing.id, {
          display_name: s.display_name,
          platform: s.platform ?? "soop",
          platform_user_id: s.platform_user_id ?? null,
          channel_url: s.channel_url ?? null,
          aliases: s.aliases ?? [],
          is_pro: s.is_pro ?? false,
          team_name: s.team_name ?? null,
          note: s.note ?? null,
        });
      }
      updated++;
      console.log(`  갱신  ${label}`);
    } else {
      if (dryRun) {
        streamerId = "(dry-run)";
      } else {
        const row = await createStreamer({
          slug: s.slug,
          display_name: s.display_name,
          platform: s.platform ?? "soop",
          platform_user_id: s.platform_user_id ?? null,
          channel_url: s.channel_url ?? null,
          aliases: s.aliases ?? [],
          is_pro: s.is_pro ?? false,
          team_name: s.team_name ?? null,
          note: s.note ?? null,
        });
        streamerId = row.id;
      }
      created++;
      console.log(`  생성  ${label}`);
    }

    for (const a of s.accounts ?? []) {
      let puuid = a.puuid;
      let gameName: string | null = null;
      let tagLine: string | null = null;

      if (a.riot_id) {
        [gameName, tagLine] = a.riot_id.split("#");
      }

      if (!puuid && riot && gameName && tagLine) {
        try {
          const acc = await riot.accountByRiotId(gameName, tagLine);
          if (!acc) {
            console.log(`        ✖ ${a.riot_id} — Riot 에 없는 계정이다 (404). 건너뛴다`);
            failed++;
            continue;
          }
          puuid = acc.puuid;
          gameName = acc.gameName ?? gameName;
          tagLine = acc.tagLine ?? tagLine;
        } catch (e) {
          if (e instanceof RiotApiError && e.isAuthProblem) throw e; // 키가 죽었으면 즉시 중단
          console.log(`        ✖ ${a.riot_id} — 조회 실패: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
          failed++;
          continue;
        }
      }

      if (!puuid) {
        console.log(`        ✖ puuid 를 얻지 못했다 (${a.riot_id ?? "?"})`);
        failed++;
        continue;
      }

      const shown = a.riot_id ?? `${puuid.slice(0, 12)}…`;
      if (dryRun) {
        console.log(`        연결 예정  ${shown}  [${a.confidence ?? "unverified"}] 근거=${a.evidence.url ?? a.evidence.note}`);
        linked++;
        continue;
      }

      await upsertRiotAccount({ puuid, game_name: gameName, tag_line: tagLine });
      await linkAccount({
        streamer_id: streamerId,
        puuid,
        label: a.label ?? null,
        is_main: a.is_main ?? false,
        confidence: a.confidence ?? "unverified",
        evidence: a.evidence,
      });
      // linkAccount 가 이미 넣지만, 옛 행이 있을 때를 대비해 한 번 더 보장한다.
      await ensureBackfillCursor(puuid);
      linked++;
      console.log(`        연결  ${shown}  [${a.confidence ?? "unverified"}]`);
    }
  }

  console.log(
    `\n생성 ${created} · 갱신 ${updated} · 계정연결 ${linked}${failed ? ` · 실패 ${failed}` : ""}` +
      (dryRun ? "  (dry-run — 실제로는 아무것도 쓰지 않았다)" : ""),
  );
  if (!dryRun && linked > 0) {
    console.log(`\n다음: npm run worker -- rank   (오늘의 랭크 스냅샷. 안 쌓으면 오늘은 영원히 구멍이다)`);
  }
} catch (e) {
  if (e instanceof RiotApiError && e.isAuthProblem) {
    console.error(`\nRiot API 키가 만료됐거나 권한이 없다 (${e.status}). 재발급 후 다시 돌릴 것.`);
  } else {
    console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = 1;
} finally {
  await closeDb();
}
