import { TRAP_PATH, VERIFY_PATH } from "@/lib/bot-guard";

/**
 * robots.txt — **검색·AI 검색 답변은 허용, AI 학습용 수집·대량 복제는 금지**(2026-10-15 운영자 결정, 약관 5조).
 *
 * ★ Next 의 robots.ts(MetadataRoute.Robots)는 정해진 칸만 낼 수 있어 Content-Signal 줄을 못 쓴다 — 그래서 라우트로 직접 낸다.
 *   Content-Signal: search=yes(검색 색인), ai-input=yes(AI 답변에 읽어 인용), ai-train=no(학습 금지).
 * ★ TRAP_PATH 는 **금지해야 함정이 된다.** robots 를 지키는 봇은 안 오고, 무시하고 링크를 전부 따라가는 수집기만 밟는다.
 * ★ 학습봇 이름은 `lib/bot-guard.ts` 의 AI_TRAINING_UA 와 같이 간다 — robots 를 무시하고 오면 거기서 403.
 *   Google-Extended·Applebot-Extended 는 robots 전용 이름이다. 막아도 구글 검색·AI 개요(Googlebot)에는 영향이 없다.
 * ★ 사이트맵 줄은 SEO P0(sitemap) 를 만들 때 붙인다.
 */
const PRIVATE = ["/admin", "/me", "/login", "/auth", TRAP_PATH, VERIFY_PATH];
const AI_TRAINING = ["GPTBot", "ClaudeBot", "anthropic-ai", "CCBot", "Google-Extended", "Applebot-Extended", "meta-externalagent",
  "cohere-training-data-crawler", "Amazonbot", "Bytespider", "Diffbot", "omgili", "Timpibot", "img2dataset", "AI2Bot", "PanguBot"];
const HARVESTERS = ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "BLEXBot", "PetalBot", "DataForSeoBot", "serpstatbot", "barkrowler"];

const BODY = [
  "# SOOP SEEK — 검색엔진·AI 검색 답변의 색인과 인용은 허용합니다.",
  "# AI 학습용 수집과 기록의 자동 대량 수집·복제는 이용약관 5조로 금지합니다.",
  "",
  "User-agent: *",
  "Content-Signal: search=yes, ai-input=yes, ai-train=no",
  "Allow: /",
  ...PRIVATE.map((p) => `Disallow: ${p}`),
  "",
  ...AI_TRAINING.map((ua) => `User-agent: ${ua}`),
  "Disallow: /",
  "",
  ...HARVESTERS.map((ua) => `User-agent: ${ua}`),
  "Disallow: /",
  "",
].join("\n");

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
