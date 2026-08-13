import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalHash } from "./canonical-json";

const sha256 = (path: string) =>
  createHash("sha256")
    .update(Uint8Array.from(readFileSync(resolve(path))))
    .digest("hex");

export type StandaloneAuthorityReceipt = {
  schemaVersion: "acceptance-standalone-authority-build/1";
  sourceHashes: Record<string, string>;
  boundaryHashes: Record<string, string>;
  identitySha256: string;
};

export function assertCurrentStandaloneAuthority(input: { receiptPath: string; authoritySources: readonly string[] }) {
  const receiptPath = resolve(input.receiptPath);
  if (!existsSync(receiptPath))
    throw new Error("Mock acceptance requires a hash-bound standalone Mission Control build");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as StandaloneAuthorityReceipt;
  if (
    receipt.schemaVersion !== "acceptance-standalone-authority-build/1" ||
    !Object.keys(receipt.boundaryHashes ?? {}).length ||
    canonicalHash({
      schemaVersion: receipt.schemaVersion,
      sourceHashes: receipt.sourceHashes,
      boundaryHashes: receipt.boundaryHashes,
    }) !== receipt.identitySha256
  )
    throw new Error("Standalone authority build receipt identity is invalid");
  for (const source of input.authoritySources)
    if (receipt.sourceHashes?.[source] !== sha256(source))
      throw new Error(
        `Mock acceptance refused a stale standalone authority boundary; rebuild after changing ${source}`,
      );
  for (const [path, expected] of Object.entries(receipt.boundaryHashes))
    if (!existsSync(resolve(path)) || sha256(path) !== expected)
      throw new Error(`Standalone authority boundary bytes changed after build: ${path}`);
  return receipt.identitySha256;
}
