/**
 * 나무위키 대회 문서에서 **경기별 대진·스코어**를 뽑는다.
 *
 *   node scripts/namu-bracket.mjs "2025 LoL 멸망전 시즌1"
 *   node scripts/namu-bracket.mjs --toc "2023 LoL BJ멸망전 시즌1"   # 목차만 본다
 *   node scripts/namu-bracket.mjs --json "..." > out.json
 *
 * ★ 요약 모델을 거치지 않는다.
 *   나무위키는 원문 HTML 을 그대로 준다. 산문을 요약시키면 스코어 좌우가 뒤집혀
 *   읽히는 일이 실제로 있었다(2025 시즌2 우승팀이 반대로 나왔다). 표를 직접 읽는다.
 *
 * ★ 무엇을 읽는가
 *   경기 결과표가 평문으로 펴면 이런 모양이다:
 *     8강 A조 1경기 (2025. 3. 19.) | 상황파악끄읏 | 2 | 0 | 중증매장센터 | O | O | X | X
 *   즉 [팀A, 점수A, 점수B, 팀B] 가 연달아 나온다. 이 패턴만 잡는다.
 *   목차(--toc)는 라운드 이름과 세트 수를 주므로 교차검증에 쓴다.
 *
 * ★ 왜 스코어가 필요한가
 *   멸망전은 전 경기 다전제다. '경기' 하나를 1판으로 적으면 판수가 틀리고
 *   진 쪽이 따낸 세트가 사라진다. 2:1 이면 3판(2승·1패)으로 펴야 맞다.
 */

const args = process.argv.slice(2);
const tocOnly = args.includes("--toc");
const asJson = args.includes("--json");
const title = args.find((a) => !a.startsWith("--"));
if (!title) {
  console.error('문서 제목을 넘겨라. 예: node scripts/namu-bracket.mjs "2025 LoL 멸망전 시즌1"');
  process.exit(1);
}

const url = `https://namu.wiki/w/${encodeURIComponent(title).replace(/%2F/g, "/")}`;
const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" } });
if (!res.ok) {
  console.error(`${res.status} — 문서가 없다: ${url}`);
  process.exit(1);
}
const html = await res.text();

const decode = (s) =>
  s
    .replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

// ── 목차 ──────────────────────────────────────────────────────────────
const toc = [...html.matchAll(/<a href=['"]#s-([\d.]+)['"][^>]*>[\d.]+<\/a>\.\s*([^<]{1,80})<\/span>/g)]
  .map((m) => ({ no: m[1], depth: m[1].split(".").length, text: decode(m[2]).trim() }));

if (tocOnly) {
  console.log(`${url}\n목차 ${toc.length}항목\n`);
  for (const t of toc) console.log(`  ${t.no.padEnd(9)} ${"  ".repeat(t.depth - 1)}${t.text}`);
  process.exit(0);
}

// ── 본문에서 [팀A, 점수A, 점수B, 팀B] 잡기 ────────────────────────────
const lines = decode(html.replace(/<[^>]+>/g, "\n"))
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const isScore = (s) => /^\d$/.test(s); // 다전제 스코어는 한 자리다 (0~3)
// 팀명이 숫자로 시작할 수 있다 — '1.단애디를던져', '2모 3촌', '4:5:1'.
// 그래서 '숫자로 시작'이 아니라 '순수한 숫자'만 걸러낸다.
// 화살표(◀ ▶)와 조회수('… ) 2.8K')는 표가 아니라 네비게이션/메타라 걸러낸다.
const NOISE = new Set(["-", "–", "—", "◀", "▶", "…", "|"]);
const isTeam = (s) =>
  s.length >= 1 && s.length <= 24 &&
  !NOISE.has(s) && !/[)(\]]/.test(s) && !/\d+(\.\d+)?[KM]$/.test(s) &&
  !/^[\d\s.]+$/.test(s) && !/\//.test(s) && !/^\d+:\d+$/.test(s) &&
  !/^(WIN|LOSE|밴|픽|결과|편집|O|X|경기|세트|다시보기|하이라이트)$/i.test(s);

const raw = [];
for (let i = 0; i + 3 < lines.length; i++) {
  if (!isScore(lines[i + 1]) || !isScore(lines[i + 2])) continue;
  const a = lines[i];
  const b = lines[i + 3];
  if (!isTeam(a) || !isTeam(b) || a === b) continue;
  const sa = Number(lines[i + 1]);
  const sb = Number(lines[i + 2]);
  if (sa === sb) continue; // 다전제에 무승부는 없다
  if (Math.max(sa, sb) > 3 || Math.max(sa, sb) < 1) continue;
  // 앞쪽에서 라운드 이름을 찾는다. 없으면 표가 아니라 네비게이션이라 버린다.
  const ctx = lines.slice(Math.max(0, i - 30), i).reverse();
  const hit = ctx.find((c) =>
    /(\d+경기|\d+라운드|승자전|패자전|최종전|결승|4강|8강|준결승|플레이오프|UB\s*\d|LB\s*\d)/.test(c),
  );
  if (!hit) continue;
  const round = hit
    .replace(/\s*\([^)]*\)\s*$/, "")               // 뒤의 날짜 괄호
    .replace(/^\d{4}\s+LoL\s+[^\s]+\s+\S+\s*/i, "") // 앞에 붙는 회차명
    .trim();
  raw.push({ round, a, sa, sb, b });
}

// 같은 (라운드, 대진) 이 여러 번 잡히면 하나로 접는다
const seen = new Map();
for (const r of raw) {
  const k = `${r.round}|${r.a}|${r.b}|${r.sa}|${r.sb}`;
  if (!seen.has(k)) seen.set(k, r);
}
const series = [...seen.values()];

if (asJson) {
  console.log(JSON.stringify({ url, series }, null, 1));
  process.exit(0);
}

console.log(`${url}\n경기 ${series.length}건  (세트 합계 ${series.reduce((n, s) => n + s.sa + s.sb, 0)}판)\n`);
console.log("  라운드                     대진                                    스코어");
for (const s of series) {
  console.log(
    `  ${(s.round || "-").slice(0, 24).padEnd(25)} ${`${s.a} vs ${s.b}`.padEnd(38)} ${s.sa}:${s.sb}`,
  );
}

console.log(`\n// meljang-seasons.mjs 붙여넣기용  [번호, 라운드, A, B, 날짜, [A승, B승]]`);
for (const [i, s] of series.entries()) {
  console.log(`      [${i + 1}, "${s.round}", "${s.a}", "${s.b}", "", [${s.sa}, ${s.sb}]],`);
}
