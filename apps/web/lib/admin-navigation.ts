/** List URLs are carried through every detail/redirect; never accept external return targets. */
export function adminReturn(value: string | null | undefined, fallback: string): string {
  if (!value?.startsWith("/admin") || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, "https://admin.invalid");
    return url.origin === "https://admin.invalid" && /^\/admin(?:\/|$)/.test(url.pathname)
      ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch { return fallback; }
}

export function adminHref(path: string, values: Record<string, string | number | undefined | null>): string {
  const url = new URL(path, "https://admin.invalid");
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function adminPage(value: string | undefined): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100_000) : 1;
}
