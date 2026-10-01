import { closeDb } from "@soop-lol/core/lib/db/client";
import { linkFcoMatchToEvent } from "@soop-lol/core/lib/games/fconline/ingest";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  const providerMatchId = option("match-id");
  const eventSlug = option("slug");
  const eventName = option("name");
  const sourceUrl = option("source-url");
  if (!providerMatchId || !eventSlug || !eventName || !sourceUrl) {
    throw new Error("사용법: npm run fco:link-event -- --match-id 넥슨matchId --slug 대회slug --name 대회명 --source-url 확인근거URL [--force]");
  }
  // 사람이 제외한 경기는 기본으로 거부한다. 의도한 것이면 --force 로 명시한다.
  await linkFcoMatchToEvent({ providerMatchId, eventSlug, eventName, sourceUrl, force: args.includes("--force") });
  console.log(`${providerMatchId} → ${eventName} 연결 완료`);
}

try { await main(); } finally { await closeDb(); }
