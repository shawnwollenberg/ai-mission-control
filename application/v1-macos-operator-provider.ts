import { createHash } from "node:crypto";
import { createMacOSLocalFixedOperations, removeStagedReplacementAssets } from "./replacement-bootstrap-macos-local";
import type { ReplacementAuthorizationPackage } from "../integrations/mission-agent/replacement-authorization-package";
import type { V1OperatorOperation, V1OperatorRequest } from "./v1-macos-operator-journal";

const LOCAL_ONLY = new Set<V1OperatorOperation>([
  "observe",
  "stage_artifact",
  "verify_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
  "verify_process",
  "collect_heartbeats",
  "verify_capabilities",
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
  "verify_rollback",
]);

const operationMap = {
  observe: ["inspect_host", "inspect_agent", "inventory_configuration"],
  stage_artifact: ["stage_target_artifact", "stage_target_plist"],
  verify_artifact: ["verify_release", "verify_target_plist"],
  stop_agent: ["stop_service"],
  install_agent: ["replace_artifact"],
  install_launch_configuration: ["replace_plist"],
  start_agent: ["start_service"],
  verify_process: ["verify_runtime", "verify_version", "verify_identity"],
  collect_heartbeats: ["verify_heartbeats"],
  verify_capabilities: ["verify_capabilities", "verify_registration"],
  restore_previous_launch_configuration: ["restore_plist"],
  restore_previous_version: ["restore_artifact"],
  verify_rollback: [
    "verify_prior_runtime",
    "verify_prior_identity",
    "verify_prior_heartbeats",
    "verify_prior_capabilities",
    "verify_prior_projection",
  ],
} as const;

export type V1ProviderReceipt = {
  providerMutationId: string;
  operation: V1OperatorOperation;
  startedAt: string;
  completedAt: string;
  resultChecksum: string;
  safeSummary: string;
  observations: unknown[];
};

export type V1MacOSOperatorProvider = {
  inspect(request: V1OperatorRequest): Promise<"precondition" | "postcondition" | "ambiguous">;
  execute(request: V1OperatorRequest): Promise<V1ProviderReceipt>;
  verify(request: V1OperatorRequest): Promise<V1ProviderReceipt>;
};

export function createV1MacOSOperatorProvider(
  repositoryRoot: string,
  authorizationPackage: ReplacementAuthorizationPackage,
): V1MacOSOperatorProvider {
  const fixed = createMacOSLocalFixedOperations(repositoryRoot);
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const receipt = (
    request: V1OperatorRequest,
    startedAt: string,
    observations: unknown[],
    recovered = false,
  ): V1ProviderReceipt => ({
    providerMutationId: request.providerMutationId,
    operation: request.operation,
    startedAt,
    completedAt: new Date().toISOString(),
    resultChecksum: sha256(
      JSON.stringify({
        providerMutationId: request.providerMutationId,
        operation: request.operation,
        observations,
      }),
    ),
    safeSummary: `${request.operation} ${recovered ? "postcondition recovered" : "completed"} through the fixed macOS provider`,
    observations,
  });
  return {
    async inspect(request) {
      if (!LOCAL_ONLY.has(request.operation)) return "postcondition";
      if (request.operation === "remove_staged_artifact") return "precondition";
      const mapped = operationMap[request.operation as keyof typeof operationMap];
      if (!mapped) throw new Error(`Unsupported v1 local operator operation: ${request.operation}.`);
      const states = await Promise.all(
        mapped
          .filter((operation) =>
            [
              "stop_service",
              "replace_artifact",
              "replace_plist",
              "start_service",
              "restore_artifact",
              "restore_plist",
            ].includes(operation),
          )
          .map((operation) =>
            fixed.inspectMutation({
              operation: operation as Parameters<typeof fixed.inspectMutation>[0]["operation"],
              pkg: authorizationPackage,
            }),
          ),
      );
      if (states.length === 0) return "precondition";
      if (states.every((state) => state === "postcondition")) return "postcondition";
      if (states.every((state) => state === "precondition")) return "precondition";
      return "ambiguous";
    },
    async execute(request) {
      if (!LOCAL_ONLY.has(request.operation))
        throw new Error(`Control-plane operation ${request.operation} cannot mutate the macOS provider.`);
      const startedAt = new Date().toISOString();
      const observations = [];
      if (request.operation === "remove_staged_artifact") {
        await removeStagedReplacementAssets(authorizationPackage.authorization);
      } else {
        const mapped = operationMap[request.operation as keyof typeof operationMap];
        if (!mapped) throw new Error(`Unsupported v1 local operator operation: ${request.operation}.`);
        for (const operation of mapped)
          observations.push(
            await fixed.execute({
              operation: operation as Parameters<typeof fixed.execute>[0]["operation"],
              operationId: request.providerMutationId,
              pkg: authorizationPackage,
            }),
          );
      }
      return receipt(request, startedAt, observations);
    },
    async verify(request) {
      const startedAt = new Date().toISOString();
      const state = await this.inspect(request);
      if (state !== "postcondition") throw new Error("Provider postcondition is not established.");
      return receipt(request, startedAt, [{ postcondition: true }], true);
    },
  };
}
