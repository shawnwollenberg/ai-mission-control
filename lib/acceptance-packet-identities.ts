import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalHash } from "./canonical-json";

export type RepresentationSensitiveJsonIdentity = Readonly<{
  rawFileSha256: string;
  canonicalJsonSha256: string;
}>;

export async function representationSensitiveJsonIdentity(path: string): Promise<RepresentationSensitiveJsonIdentity> {
  const bytes = await readFile(resolve(path));
  return Object.freeze({
    rawFileSha256: createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"),
    canonicalJsonSha256: canonicalHash(JSON.parse(bytes.toString("utf8"))),
  });
}

export async function runtimeModeDefinitionIdentities() {
  return representationSensitiveJsonIdentity("domain/runtime-mode-definition.json");
}
