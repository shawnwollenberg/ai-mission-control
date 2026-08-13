import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalHash, canonicalJson } from "./canonical-json";
import type { AcceptanceResourceInventory } from "./acceptance-resource-inventory";
import {
  preReviewProducerByStep,
  producePreReviewEvidence,
  validateProducedPreReviewEvidence,
} from "./acceptance-pre-review-producers";
import type { AcceptanceCandidateBindings } from "./acceptance-requirement-evidence";

export const GOVERNED_SCENARIO_EXECUTION_VERSION = "governed-scenario-execution/1" as const;

export const governedScenarioDefinitions = [
  {
    requirementId: "REQ-F726328FF0F3994B",
    stepId: "recovery.provider_restart",
    scenarioId: "provider_restart",
    schemaId: "provider-recovery-result/4",
    producerId: "produce:recovery.provider_restart/4",
    validatorId: "validate:recovery.provider_restart/4",
    producerSchemaVersion: 4,
    activeProviderRequired: true,
  },
  {
    requirementId: "REQ-8F07660DBDB2F890",
    stepId: "recovery.lease_loss",
    scenarioId: "lease_loss",
    schemaId: "lease-loss-observation/2",
    producerId: "produce:recovery.lease_loss/2",
    validatorId: "validate:recovery.lease_loss/2",
    producerSchemaVersion: 2,
    activeProviderRequired: true,
  },
  {
    requirementId: "REQ-BF2841A5FA3154F2",
    stepId: "recovery.delayed_output",
    scenarioId: "delayed_output",
    schemaId: "delayed-output-observation/2",
    producerId: "produce:recovery.delayed_output/2",
    validatorId: "validate:recovery.delayed_output/2",
    producerSchemaVersion: 2,
    activeProviderRequired: true,
  },
  {
    requirementId: "REQ-3F10A64C778C6510",
    stepId: "recovery.conflicting_receipt",
    scenarioId: "conflicting_receipt",
    schemaId: "conflicting-receipt-observation/2",
    producerId: "produce:recovery.conflicting_receipt/2",
    validatorId: "validate:recovery.conflicting_receipt/2",
    producerSchemaVersion: 2,
    activeProviderRequired: true,
  },
  {
    requirementId: "REQ-7B0A244AB941902C",
    stepId: "isolation.production_resources_rejected",
    scenarioId: "production_resource_rejection",
    schemaId: "production-resource-rejection-observation/2",
    producerId: "produce:isolation.production_resources_rejected/2",
    validatorId: "validate:isolation.production_resources_rejected/2",
    producerSchemaVersion: 2,
    activeProviderRequired: false,
  },
  {
    requirementId: "REQ-400B51CA2DEA7743",
    stepId: "recovery.mission_control_restart",
    scenarioId: "mission_control_restart",
    schemaId: "mission-control-restart-observation/3",
    producerId: "produce:recovery.mission_control_restart/3",
    validatorId: "validate:recovery.mission_control_restart/3",
    producerSchemaVersion: 3,
    activeProviderRequired: false,
  },
  {
    requirementId: "REQ-A42EC85F62AEFC15",
    stepId: "isolation.disposable_database_only",
    scenarioId: "disposable_database_isolation",
    schemaId: "disposable-database-isolation-observation/2",
    producerId: "produce:isolation.disposable_database_only/2",
    validatorId: "validate:isolation.disposable_database_only/2",
    producerSchemaVersion: 2,
    activeProviderRequired: false,
  },
  {
    requirementId: "REQ-6BD097D5CF920BF4",
    stepId: "adversarial.wrong_canonical_plan_hash_rejected",
    scenarioId: "wrong_canonical_plan_hash",
    schemaId: "wrong-canonical-plan-hash-observation/2",
    producerId: "produce:adversarial.wrong_canonical_plan_hash_rejected/2",
    validatorId: "validate:adversarial.wrong_canonical_plan_hash_rejected/2",
    producerSchemaVersion: 2,
    activeProviderRequired: false,
  },
  {
    requirementId: "REQ-014AA0AC8BAE841A",
    stepId: "adversarial.repository_drift_rejected",
    scenarioId: "repository_drift",
    schemaId: "repository-drift-observation/2",
    producerId: "produce:adversarial.repository_drift_rejected/2",
    validatorId: "validate:adversarial.repository_drift_rejected/2",
    producerSchemaVersion: 2,
    activeProviderRequired: false,
  },
  {
    requirementId: "REQ-D8750DD32D61F788",
    stepId: "adversarial.source_closure_mutation_matrix",
    scenarioId: "source_closure_mutation_matrix",
    schemaId: "source-closure-mutation-observation/2",
    producerId: "produce:adversarial.source_closure_mutation_matrix/2",
    validatorId: "validate:adversarial.source_closure_mutation_matrix/2",
    producerSchemaVersion: 2,
    activeProviderRequired: false,
  },
  {
    requirementId: "REQ-57F6345836E7244C",
    stepId: "adversarial.checkpoint_identity_and_reuse",
    scenarioId: "checkpoint_identity_and_reuse",
    schemaId: "checkpoint-misuse-observation/2",
    producerId: "produce:adversarial.checkpoint_identity_and_reuse/2",
    validatorId: "validate:adversarial.checkpoint_identity_and_reuse/2",
    producerSchemaVersion: 2,
    activeProviderRequired: false,
  },
] as const;

export type GovernedScenarioDefinition = (typeof governedScenarioDefinitions)[number];
export type GovernedScenarioId = GovernedScenarioDefinition["scenarioId"];

export type GovernedScenarioBinding = Readonly<{
  acceptanceRunId: string;
  candidateIdentitySha256: string;
  requirementId: GovernedScenarioDefinition["requirementId"];
  scenarioId: GovernedScenarioId;
  workspaceId: string;
  repositoryId: string;
  repositorySnapshotSha256: string;
  repositoryAuthoritySha256: string;
  agentId: string | null;
  assignmentId: string | null;
  attemptId: string | null;
  provider: string | null;
  model: string | null;
  role: string | null;
  runtimeProfile: string | null;
}>;

export type GovernedScenarioRawObservation = GovernedScenarioBinding &
  Readonly<{
    schemaVersion: string;
    baselineStateSha256: string;
    terminalStateSha256: string;
    observedCommandIdentity: string;
    observedResultIdentity: string;
    observedAt: string;
    [key: string]: unknown;
  }>;

export type GovernedScenarioDriver = (binding: GovernedScenarioBinding) => Promise<GovernedScenarioRawObservation>;

const prohibitedConclusionKeys = new Set(["passed", "satisfied", "success", "rejectedCorrectly", "expectedOutcomeMet"]);
const sha = (value: unknown) => /^[a-f0-9]{64}$/.test(String(value));

function assertSerializableObservation(value: unknown, path = "observation"): void {
  if (value === undefined) throw new Error(`Governed scenario observation contains undefined at ${path}`);
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error(`Governed scenario observation contains a non-finite number at ${path}`);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializableObservation(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (prohibitedConclusionKeys.has(key))
      throw new Error(`Governed scenario observation contains prohibited conclusion field ${path}.${key}`);
    assertSerializableObservation(child, `${path}.${key}`);
  }
}

function definitionFor(binding: GovernedScenarioBinding) {
  const definition = governedScenarioDefinitions.find((item) => item.scenarioId === binding.scenarioId);
  if (!definition || definition.requirementId !== binding.requirementId)
    throw new Error("Governed scenario requirement/implementation binding is invalid");
  const producer = preReviewProducerByStep.get(definition.stepId);
  if (
    !producer ||
    producer.producerId !== definition.producerId ||
    producer.validatorId !== definition.validatorId ||
    producer.schemaId !==
      `requirement-raw-${definition.stepId.replaceAll(".", "-")}/${definition.producerSchemaVersion}`
  )
    throw new Error(`Governed scenario producer binding changed: ${definition.scenarioId}`);
  return definition;
}

function validateCommonObservation(
  definition: GovernedScenarioDefinition,
  binding: GovernedScenarioBinding,
  observation: GovernedScenarioRawObservation,
) {
  if (
    observation.schemaVersion !== definition.schemaId ||
    observation.requirementId !== definition.requirementId ||
    observation.scenarioId !== definition.scenarioId ||
    observation.acceptanceRunId !== binding.acceptanceRunId ||
    observation.workspaceId !== binding.workspaceId ||
    observation.candidateIdentitySha256 !== binding.candidateIdentitySha256 ||
    observation.repositoryId !== binding.repositoryId ||
    observation.repositorySnapshotSha256 !== binding.repositorySnapshotSha256 ||
    observation.repositoryAuthoritySha256 !== binding.repositoryAuthoritySha256 ||
    !sha(observation.baselineStateSha256) ||
    !sha(observation.terminalStateSha256) ||
    !observation.observedCommandIdentity ||
    !observation.observedResultIdentity ||
    !Number.isFinite(Date.parse(observation.observedAt))
  )
    throw new Error(`Governed scenario observation binding is invalid: ${definition.scenarioId}`);
  if (
    definition.activeProviderRequired &&
    (observation.agentId !== binding.agentId ||
      observation.assignmentId !== binding.assignmentId ||
      observation.attemptId !== binding.attemptId ||
      observation.provider !== binding.provider ||
      observation.model !== binding.model ||
      observation.role !== binding.role ||
      observation.runtimeProfile !== binding.runtimeProfile ||
      [
        observation.agentId,
        observation.assignmentId,
        observation.attemptId,
        observation.provider,
        observation.model,
        observation.role,
        observation.runtimeProfile,
      ].some((value) => !value))
  )
    throw new Error(`Governed scenario active-provider binding is incomplete or changed: ${definition.scenarioId}`);
}

function producerSources(definition: GovernedScenarioDefinition, observation: GovernedScenarioRawObservation) {
  const base = { packet: {}, registry: {}, preflight: {} };
  if (definition.scenarioId === "production_resource_rejection")
    return { ...base, isolation: { productionResourceRejection: observation } };
  if (definition.scenarioId === "disposable_database_isolation")
    return { ...base, isolation: { disposableDatabaseIsolation: observation } };
  if (definition.scenarioId === "wrong_canonical_plan_hash")
    return { ...base, adversarial: { wrongCanonicalPlanHash: observation } };
  if (definition.scenarioId === "repository_drift") return { ...base, adversarial: { repositoryDrift: observation } };
  if (definition.scenarioId === "source_closure_mutation_matrix")
    return { ...base, adversarial: { sourceClosureMutation: observation } };
  if (definition.scenarioId === "checkpoint_identity_and_reuse")
    return { ...base, adversarial: { checkpointMisuse: observation } };
  if (definition.scenarioId === "mission_control_restart")
    return { ...base, recovery: { missionControlRestart: observation } };
  const key = {
    provider_restart: "providerRestart",
    lease_loss: "leaseLoss",
    delayed_output: "delayedOutput",
    conflicting_receipt: "conflictingReceipt",
  }[definition.scenarioId];
  return { ...base, recovery: { [key!]: observation } };
}

export async function executeGovernedScenario(input: {
  binding: GovernedScenarioBinding;
  driver: GovernedScenarioDriver;
  evidenceRoot: string;
  inventory: AcceptanceResourceInventory;
  persistInventory: (event: string) => void;
  retentionPolicyIdentity: string;
  candidateBindings: AcceptanceCandidateBindings;
  secretScan: (bytes: Buffer) => void;
}) {
  const definition = definitionFor(input.binding);
  const observation = await input.driver(input.binding);
  assertSerializableObservation(observation);
  validateCommonObservation(definition, input.binding, observation);
  const bytes = Buffer.from(`${canonicalJson(observation)}\n`);
  input.secretScan(bytes);
  const observationSha256 = canonicalHash(observation);
  const resourceId = `scenario-observation-${definition.requirementId.toLowerCase()}`;
  const finalPath = join(input.evidenceRoot, `${definition.requirementId}-${definition.scenarioId}.json`);
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, Uint8Array.from(bytes));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, finalPath);
  const directory = openSync(dirname(finalPath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  const persisted = JSON.parse(await readFile(finalPath, "utf8"));
  if (canonicalHash(persisted) !== observationSha256)
    throw new Error(`Governed scenario sealed observation changed: ${definition.scenarioId}`);
  input.inventory.register({
    resourceId,
    type: "diagnostic_artifact",
    identity: {
      path: finalPath,
      artifactSha256: observationSha256,
      requirementId: definition.requirementId,
      scenarioId: definition.scenarioId,
      sealed: "true",
    },
    creatingStep: `scenario.${definition.scenarioId}.observation.seal`,
    createdAt: observation.observedAt,
    cleanupPolicy: "retain_evidence_only",
    expectedTerminalState: "retained_with_approved_reason",
    retentionPolicyIdentity: input.retentionPolicyIdentity,
    lifecycleState: "sealed",
  });
  input.persistInventory("governed_scenario_observation_sealed");
  const context = {
    acceptanceRunId: input.binding.acceptanceRunId,
    candidateBindings: input.candidateBindings,
    observedAt: observation.observedAt,
  };
  const proof = producePreReviewEvidence(definition.stepId, producerSources(definition, persisted), context);
  const validationReasons = validateProducedPreReviewEvidence(definition.stepId, proof, context);
  if (validationReasons.length)
    throw new Error(
      `Governed scenario semantic validation failed: ${definition.scenarioId}:${validationReasons.join(",")}`,
    );
  return Object.freeze({
    schemaVersion: GOVERNED_SCENARIO_EXECUTION_VERSION,
    definition,
    observationPath: finalPath,
    observationSha256,
    resourceId,
    proofIdentitySha256: canonicalHash(proof),
  });
}

export const governedScenarioRegistryIdentity = canonicalHash(governedScenarioDefinitions);

export function validateGovernedScenarioRegistry() {
  if (
    governedScenarioDefinitions.length !== 11 ||
    new Set(governedScenarioDefinitions.map((item) => item.requirementId)).size !== 11 ||
    new Set(governedScenarioDefinitions.map((item) => item.scenarioId)).size !== 11
  )
    throw new Error("Governed scenario registry is incomplete or ambiguous");
  for (const definition of governedScenarioDefinitions)
    definitionFor({
      requirementId: definition.requirementId,
      scenarioId: definition.scenarioId,
    } as GovernedScenarioBinding);
  return governedScenarioRegistryIdentity;
}
