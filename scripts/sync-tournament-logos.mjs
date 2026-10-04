/** 확인한 대회별 시즌 로고·타이틀 원본을 로컬 정적 파일로 보관한다. 출처는 manifest에 남긴다.
 * node scripts/sync-tournament-logos.mjs [--refresh]
 * 기본은 없는 파일만 받는다. 이미지 변형이나 다른 시즌으로의 추정 매핑은 하지 않는다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { soopFetch } from "./lib/soop-http.mjs";

const root = new URL("..", import.meta.url).pathname;
const manifestPath = join(root, "packages/modules/tournaments/data/tournament-logos.json");
const entries = JSON.parse(await readFile(manifestPath, "utf8"));
let downloaded = 0;
for (const entry of entries) {
  if (!/^\/images\/tournament-logos\/meljang-[a-z0-9-]+\.(png|jpg|jpeg|webp)$/.test(entry.src)) throw new Error(`Invalid asset path: ${entry.src}`);
  const path = join(root, "apps/web/public", entry.src);
  let bytes;
  let needsWrite = false;
  if (!process.argv.includes("--refresh")) bytes = await readFile(path).catch(() => null);
  if (!bytes) {
    const url = new URL(entry.imageUrl);
    const fetchImage = url.hostname.endsWith("sooplive.com") ? soopFetch : fetch;
    const response = await fetchImage(url.href, { signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
      throw new Error(`${entry.eventSlug}: image download failed (${response.status})`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    needsWrite = true;
    downloaded++;
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (entry.sha256 && entry.sha256 !== hash) throw new Error(`${entry.eventSlug}: original image changed; review before replacing`);
  if (needsWrite) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  entry.sha256 = hash;
  console.log(`${entry.eventSlug}: ${bytes.length} bytes`);
}
await writeFile(manifestPath, JSON.stringify(entries, null, 2) + "\n");
console.log(`${entries.length} tournament logos verified; ${downloaded} downloaded`);
