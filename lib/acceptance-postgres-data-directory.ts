import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export function governedPostgresDataDirectory(dataDirectory: string, acceptanceRoot: string) {
  const path = realpathSync(resolve(dataDirectory));
  const root = realpathSync(resolve(acceptanceRoot));
  if (!statSync(path).isDirectory() || path === root || !path.startsWith(`${root}${sep}`))
    throw new Error("Disposable PostgreSQL requires a pre-created governed data directory");
  return path;
}
