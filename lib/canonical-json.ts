import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const jsonValue = value as { toJSON?: () => unknown };
    if (typeof jsonValue.toJSON === "function") return canonicalJson(jsonValue.toJSON());
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
