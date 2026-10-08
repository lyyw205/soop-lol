/**
 * 본문 자동 링크 — 일반 텍스트에서 http(s) 주소만 링크로 가른다. docs/COMMUNITY-PLAN.md §3 "글·댓글"
 *
 * ★ HTML 을 해석하지 않는다. 나머지는 전부 글자 그대로 남고 React 가 이스케이프한다(dangerouslySetInnerHTML 을 쓰지 않는다).
 * ★ http·https 만 링크가 된다 — javascript:·data: 같은 스킴은 글자로 남는다.
 * ★ 주소 끝에 붙은 문장 부호(. , ! ? ) 등)는 링크에서 뗀다 — "여기 https://a.com." 의 마침표가 주소로 들어가지 않게.
 */

export type TextPart = { kind: "text"; value: string } | { kind: "link"; value: string; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,!?;:)\]}'"…]+$/u;

export function autolinkParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const prev = parts[parts.length - 1];
    if (prev?.kind === "text") prev.value += value;
    else parts.push({ kind: "text", value });
  };
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const trail = TRAILING.exec(match[0])?.[0] ?? "";
    const raw = trail ? match[0].slice(0, -trail.length) : match[0];
    pushText(text.slice(last, start));
    let href: string | null = null;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") href = url.toString();
    } catch {
      href = null;
    }
    if (href && raw.length > "https://".length) parts.push({ kind: "link", value: raw, href });
    else pushText(raw);
    pushText(trail);
    last = start + match[0].length;
  }
  pushText(text.slice(last));
  return parts;
}
