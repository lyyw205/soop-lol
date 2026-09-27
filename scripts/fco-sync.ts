import { closeDb } from "@soop-lol/core/lib/db/client";
import { NexonClient } from "@soop-lol/core/lib/games/fconline/client";
import { linkFcoAccount } from "@soop-lol/core/lib/games/fconline/ingest";
import { syncFcoMatches } from "@soop-lol/core/lib/games/fconline/sync";
import { listUnlinkedInEventWindows } from "@soop-lol/core/lib/games/fconline/context";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}
const flag = (name: string) => args.includes(`--${name}`);

async function main() {
  const streamerSlug = option("streamer");
  const nickname = option("nickname");
  const ouidOption = option("ouid");
  if (!streamerSlug || (!nickname && !ouidOption)) {
    throw new Error("사용법: npm run fco:sync -- --streamer 스트리머slug (--nickname 감독명 | --ouid 계정ID) [--source-url 근거URL] [--refetch]");
  }
  if (option("limit") || option("offset")) {
    throw new Error("--limit/--offset 은 없앴다 — 목록은 이 계정을 마지막으로 끝까지 읽은 지점(없으면 30일 끝)까지 넘겨 받는다.");
  }
  // 기본은 친선(40)만 — 워커와 같다(apps/worker/src/config.ts 의 결정 참고).
  const types = (option("matchtypes") ?? "40").split(",").map(Number);
  if (!types.length || types.some((type) => !Number.isInteger(type) || type < 0)) {
    throw new Error("matchtypes는 쉼표로 구분한 매치 타입 번호여야 합니다.");
  }
  const apiKey = process.env.NEXON_API_KEY;
  if (!apiKey) throw new Error("NEXON_API_KEY가 필요합니다.");
  const client = new NexonClient({ apiKey });
  // 감독명은 바뀐다(실측: 꾸잔사마→축구왕임홍택). 조사에서 확인한 계정 ID 가 있으면 그걸 쓴다.
  const ouid = ouidOption ?? await client.ouidByNickname(nickname!);
  if (!ouid) throw new Error(`감독명을 찾을 수 없습니다: ${nickname}`);
  const basic = await client.userBasic(ouid);
  if (!basic) throw new Error("감독 기본 정보를 찾을 수 없습니다.");
  await linkFcoAccount({ streamerSlug, ouid, nickname: basic.nickname, level: basic.level, sourceUrl: option("source-url") });
  // 워커 Engine E 와 같은 함수다. --refetch 면 커서를 무시하고 끝까지, 저장된 경기 상세도 다시 받는다.
  const r = await syncFcoMatches(client, ouid, { types, refetchKnown: flag("refetch") });
  const COVER = { end: "끝까지", caught_up: "지난 지점까지", capped: "상한에서 멈춤", error: "실패" } as const;
  const listed = Object.entries(r.listed)
    .map(([t, n]) => `type${t}=${n === "error" ? "실패" : `${n}건`}(${COVER[r.coverage[t]]})`).join(" ");
  console.log(`${basic.nickname}: 목록 ${listed}`);
  if (!r.cursorAdvanced) console.log("  ⚠ 목록을 빈틈없이 못 읽었다 — 커서를 안 옮겼다. 다음 수집이 다시 끝까지 본다.");
  console.log(`${r.saved}경기 저장, ${r.known}경기 이미 있음, ${r.unsupported}경기 1:1 외 모드 제외, ${r.missing}경기 상세 없음, API ${client.callCount}회`);
  for (const message of r.errors) console.log(`  ⚠ ${message}`);

  // 새로 연결한 사람의 경기가 이미 있는 행사 기간 안에 있으면 알린다 — 계정만 붙이고
  // 행사 연결을 잊는 실수를 막는다(판단은 조사자가 한다).
  const loose = await listUnlinkedInEventWindows(streamerSlug);
  if (loose.length) {
    console.log(`\n⚠ 행사 기간 안인데 행사에 안 붙은 경기 ${loose.length}건 — 대회 경기인지 확인하라:`);
    for (const m of loose) {
      const kst = new Date(new Date(m.played_at).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
      console.log(`  ${kst} ${m.players} → ${m.event_name}(${m.event_slug}) · ${m.provider_match_id}`);
    }
  }
}

try { await main(); } finally { await closeDb(); }
