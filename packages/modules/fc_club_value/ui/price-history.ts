/** A card without a positive daily quote has no observable market price.
 * Do not label the first quote as its release date, or remove real low prices. */
export function quotedPrices<T extends { value: number }>(points: readonly T[]): T[] {
  return points.filter(p => Number.isFinite(p.value) && p.value > 0);
}

/** Daily quotes separated by missing days must not imply continuous coverage. */
export function dailyPricePath(points: readonly { day: string; y: number }[], x: (day: string) => number, y: (value: number) => number): string {
  return points.map((p, i) => {
    const consecutive = i > 0 && Date.parse(p.day) - Date.parse(points[i - 1].day) === 86_400_000;
    return `${consecutive ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.y).toFixed(1)}`;
  }).join("");
}

/** Observed squads take precedence on their exact valuation dates. No gap filling. */
export function mergeSquadHistory<T extends { day: string; value: number }>(estimated: readonly T[], collected: readonly T[]): T[] {
  const byDay = new Map(estimated.map(point => [point.day, point]));
  for (const point of collected) byDay.set(point.day, point);
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
