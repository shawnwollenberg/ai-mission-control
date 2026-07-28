import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildIdentityDigest,
  validateBuildProvenance,
  type V1BuildProvenance,
} from "@/application/v1-production-runtime-identity";

let cached: V1BuildProvenance | null | undefined;

export function readEmbeddedV1BuildProvenance(): V1BuildProvenance | null {
  if (cached !== undefined) return cached;
  for (const path of [
    resolve(process.cwd(), "mission-control-build-provenance.json"),
    resolve(process.cwd(), ".next/standalone/mission-control-build-provenance.json"),
  ])
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as V1BuildProvenance;
      validateBuildProvenance(value);
      cached = value;
      return cached;
    } catch {
      // Try the next immutable bundle location.
    }
  cached = null;
  return cached;
}

export function safeEmbeddedV1BuildIdentity() {
  const provenance = readEmbeddedV1BuildProvenance();
  return provenance
    ? {
        sourceCommit: provenance.sourceCommit,
        sourceTreeObject: provenance.sourceTreeObject,
        buildIdentityDigest: buildIdentityDigest(provenance),
        buildMode: provenance.buildMode,
      }
    : null;
}
