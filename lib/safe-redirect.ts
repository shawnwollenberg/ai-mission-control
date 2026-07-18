export function safeInternalRedirect(value: string | null | undefined, fallback = "/missions"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const parsed = new URL(value, "http://mission-control.local");
    if (parsed.origin !== "http://mission-control.local") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
