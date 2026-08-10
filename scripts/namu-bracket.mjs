/**
 * 나무위키 대회 문서에서 경기별 대진·스코어를 뽑아 본다 (조사용).
 *
 *   node scripts/namu-bracket.mjs "2025 LoL 멸망전 시즌1"
 *   node scripts/namu-bracket.mjs --toc "2023 LoL BJ멸망전 시즌1"   # 목차만
 *   node scripts/namu-bracket.mjs --json "..." > out.json
 *
 * 실제 파싱은 scripts/lib/namu.mjs 에 있다 — 빌더와 같은 코드를 쓴다.
 * 여기서 따로 구현하면 조사에서 보이던 게 빌드에서 안 보이는 일이 생긴다.
 */
import { fetchSeries, fetchToc, namuUrl } from "./lib/namu.mjs";

const args = process.argv.slice(2);
const tocOnly = args.includes("--toc");
const asJson = args.includes("--json");
const title = args.find((a) => !a.startsWith("--"));
if (!title) {
  console.error('문서 제목을 넘겨라. 예: node scripts/namu-bracket.mjs "2025 LoL 멸망전 시즌1"');
  process.exit(1);
}

if (tocOnly) {
  const toc = await fetchToc(title);
  if (!toc) { console.error(`문서가 없다: ${namuUrl(title)}`); process.exit(1); }
  console.log(`${namuUrl(title)}\n목차 ${toc.length}항목\n`);
  for (const t of toc) console.log(`  ${t.no.padEnd(9)} ${"  ".repeat(t.depth - 1)}${t.text}`);
  process.exit(0);
}

const { ok, series } = await fetchSeries(title);
if (!ok) { console.error(`문서가 없다: ${namuUrl(title)}`); process.exit(1); }

if (asJson) {
  console.log(JSON.stringify({ url: namuUrl(title), series }, null, 1));
  process.exit(0);
}

console.log(
  `${namuUrl(title)}\n경기 ${series.length}건  (세트 합계 ${series.reduce((n, s) => n + s.sa + s.sb, 0)}판)\n`,
);
console.log("  라운드                     대진                                    스코어");
for (const s of series) {
  console.log(
    `  ${(s.round || "-").slice(0, 24).padEnd(25)} ${`${s.a} vs ${s.b}`.padEnd(38)} ${s.sa}:${s.sb}`,
  );
}

console.log(`\n// meljang-seasons.mjs 붙여넣기용  [번호, 라운드, A, B, 날짜]`);
for (const [i, s] of series.entries()) {
  console.log(`      [${i + 1}, "${s.round}", "${s.a}", "${s.b}", ""],`);
}
