/**
 * 판 목록의 빌드 아이콘 — 아이템·소환사 주문·룬. 표는 build-icons.json(Data Dragon 에서 생성, `npm run sync:build-icons`),
 * 이미지는 apps/web/public/images/lol/ 아래에 같이 배포된다. 모르는 id 는 null — 빈 칸으로 그린다.
 */
import table from "./build-icons.json" with { type: "json" };

const T = table as { version: string; item: Record<string, string>; spell: Record<string, string>; rune: Record<string, string> };

export const BUILD_ICON_VERSION = T.version;
export const itemName = (id: number): string | null => (id > 0 ? T.item[id] ?? null : null);
export const spellName = (id: number | null): string | null => (id != null ? T.spell[id] ?? null : null);
export const runeName = (id: number | null): string | null => (id != null ? T.rune[id] ?? null : null);
export const itemIconPath = (id: number): string | null => (itemName(id) ? `/images/lol/item/${id}.png` : null);
export const spellIconPath = (id: number | null): string | null => (spellName(id) ? `/images/lol/spell/${id}.png` : null);
export const runeIconPath = (id: number | null): string | null => (runeName(id) ? `/images/lol/rune/${id}.png` : null);
