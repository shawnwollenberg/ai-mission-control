import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDisposableReplacementDependencies } from "../application/replacement-bootstrap-disposable";
import {
  executeReplacementBootstrap,
  replacementPreflight,
  type OperatorMode,
} from "../application/replacement-bootstrap-operator";
import {
  NAMED_CANARY_ID,
  REPLACEMENT_BOOTSTRAP_PROTOCOL,
  validateReplacementAuthorization,
  type ReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap";

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      "authorization-id": { type: "string" },
      "agent-id": { type: "string" },
      mode: { type: "string" },
      "evidence-output": { type: "string" },
      acknowledge: { type: "string" },
      "authorization-fixture": { type: "string" },
      "inject-failure": { type: "string" },
      resume: { type: "boolean", default: false },
    },
    strict: true,
  });

  const mode = parsed.values.mode as OperatorMode | undefined;
  const authorizationId = parsed.values["authorization-id"];
  const agentId = parsed.values["agent-id"];
  if (!mode || !["dry-run", "disposable", "production"].includes(mode))
    throw new Error("--mode must be dry-run, disposable, or production.");
  if (!authorizationId || !agentId) throw new Error("--authorization-id and --agent-id are required.");
  if (agentId !== NAMED_CANARY_ID) throw new Error("Only the exact named canary is supported.");
  if (mode === "production")
    throw new Error(
      "Production execution is blocked in this repair authorization. The same reviewed entrypoint must be enabled only by a new commit-bound execution authorization.",
    );

  const fixturePath =
    parsed.values["authorization-fixture"] ??
    "release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json";
  const authorization = validateReplacementAuthorization(
    JSON.parse(await readFile(fixturePath, "utf8")) as ReplacementAuthorization,
    { now: new Date("2026-07-28T00:00:00.000Z") },
  );
  if (authorization.authorizationId !== authorizationId) throw new Error("Authorization ID does not match the record.");
  const dependencies = await createDisposableReplacementDependencies(authorization, {
    failAt: parsed.values["inject-failure"] as never,
  });
  const common = {
    mode,
    authorizationId,
    assertedAgentId: agentId,
    actor: authorization.operatorIdentity,
    dependencies,
  };
  const result = parsed.values.resume
    ? await (
        await import("../application/replacement-bootstrap-operator")
      ).recoverReplacementBootstrap({
        authorizationId,
        assertedAgentId: agentId,
        actor: authorization.operatorIdentity,
        dependencies,
      })
    : mode === "dry-run"
      ? (await replacementPreflight(common)).report
      : await executeReplacementBootstrap({
          ...common,
          mode: "disposable",
          acknowledge:
            parsed.values.acknowledge === REPLACEMENT_BOOTSTRAP_PROTOCOL
              ? REPLACEMENT_BOOTSTRAP_PROTOCOL
              : ("" as typeof REPLACEMENT_BOOTSTRAP_PROTOCOL),
        });
  const output = resolve(parsed.values["evidence-output"] ?? authorization.evidenceDestination);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ disposition: "disposition" in result ? result.disposition : "preflight-passed", mode, evidenceOutput: output })}\n`,
  );
}

void main();
