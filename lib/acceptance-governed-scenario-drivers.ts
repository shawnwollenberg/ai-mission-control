import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCanonicalPlanVerdictAuthority } from "@/application/consensus-plan-commands";
import { evaluateResourceAuthority } from "@/application/resource-authority";
import { assertAssignmentLeaseAuthority } from "@/application/pull-assignments";
import {
  assertConsensusValidationReceiptAuthority,
  assertRemoteExecutionOutputAuthority,
} from "@/application/remote-agent-messages";
import { ApplicationError } from "@/lib/application-errors";
import { canonicalHash } from "@/lib/canonical-json";
import {
  AcceptanceSourceCheckpointController,
  AcceptanceSourceCheckpointRejection,
  AcceptanceSourceClosureFailure,
  loadApprovedAcceptanceSource,
} from "@/lib/acceptance-source-checkpoints";
import { assertRepositorySnapshotAuthority } from "@/domain/repository-snapshot";
import { runtimeTrustEvidence } from "@/lib/runtime-trust";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function structuredRejection(operation: () => void) {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    return {
      actualTopLevelErrorCode: error.code,
      actualRejectionCode: error.details?.reason_code,
    } as const;
  }
  throw new Error("Governed scenario command unexpectedly succeeded");
}

export function observeLeaseLossRejection(input: {
  leaseOwnerBefore: string;
  leaseTokenBefore: string;
  leaseOwnerAfter: string;
  leaseTokenAfter: string;
  leaseExpiresAtAfter: Date;
  fencingTokenBefore: number;
  fencingTokenAfter: number;
}) {
  const activeRow = {
    lease_owner: input.leaseOwnerBefore,
    lease_token_hash: sha256(input.leaseTokenBefore),
    lease_expires_at: new Date(Date.now() + 60_000),
    fencing_token: input.fencingTokenBefore,
    payload: { missionType: "consensus_plan" },
  };
  assertAssignmentLeaseAuthority(
    {
      leaseOwner: input.leaseOwnerBefore,
      leaseToken: input.leaseTokenBefore,
      fencingToken: input.fencingTokenBefore,
    },
    activeRow,
  );
  const reclaimedRow = {
    ...activeRow,
    lease_owner: input.leaseOwnerAfter,
    lease_token_hash: sha256(input.leaseTokenAfter),
    lease_expires_at: input.leaseExpiresAtAfter,
    fencing_token: input.fencingTokenAfter,
  };
  return {
    activeLeaseFingerprint: sha256(input.leaseTokenBefore),
    activeFencingIdentity: sha256(`${input.leaseOwnerBefore}:${input.fencingTokenBefore}`),
    reclaimedLeaseFingerprint: sha256(input.leaseTokenAfter),
    reclaimedFencingIdentity: sha256(`${input.leaseOwnerAfter}:${input.fencingTokenAfter}`),
    ...structuredRejection(() =>
      assertAssignmentLeaseAuthority(
        {
          leaseOwner: input.leaseOwnerBefore,
          leaseToken: input.leaseTokenBefore,
          fencingToken: input.fencingTokenBefore,
        },
        reclaimedRow,
      ),
    ),
  } as const;
}

export function observeDelayedOutputRejection(input: {
  authorizedStatus: string;
  terminalStatus: string;
  messageType: string;
  outputFencedAt: Date;
  outputFenceReason: string;
}) {
  assertRemoteExecutionOutputAuthority({
    status: input.authorizedStatus,
    cancellationRequestedAt: null,
    outputFencedAt: null,
    outputFenceReason: null,
    messageType: input.messageType,
  });
  return structuredRejection(() =>
    assertRemoteExecutionOutputAuthority({
      status: input.terminalStatus,
      cancellationRequestedAt: null,
      outputFencedAt: input.outputFencedAt,
      outputFenceReason: input.outputFenceReason,
      messageType: input.messageType,
    }),
  );
}

export function observeConflictingReceiptRejection(input: {
  persistedReceiptSha256: string;
  submittedReceiptSha256: string;
}) {
  assertConsensusValidationReceiptAuthority(input.persistedReceiptSha256, input.persistedReceiptSha256);
  return structuredRejection(() =>
    assertConsensusValidationReceiptAuthority(input.persistedReceiptSha256, input.submittedReceiptSha256),
  );
}

export function observeWrongCanonicalPlanHashRejection(input: {
  reviewedArtifactId: string;
  approvedCanonicalPlanSha256: string;
  attemptedCanonicalPlanSha256: string;
}) {
  return structuredRejection(() =>
    assertCanonicalPlanVerdictAuthority(
      {
        reviewedArtifactId: input.reviewedArtifactId,
        canonicalPlanHash: input.attemptedCanonicalPlanSha256,
      },
      {
        reviewedArtifactId: input.reviewedArtifactId,
        canonicalPlanHash: input.approvedCanonicalPlanSha256,
      },
    ),
  );
}

export function observeRepositoryDriftRejection(input: {
  approvedRepositorySnapshotSha256: string;
  observedRepositorySnapshotSha256: string;
}) {
  assertRepositorySnapshotAuthority(input.approvedRepositorySnapshotSha256, input.approvedRepositorySnapshotSha256);
  return structuredRejection(() =>
    assertRepositorySnapshotAuthority(input.observedRepositorySnapshotSha256, input.approvedRepositorySnapshotSha256),
  );
}

const sourceBinding = {
  action: "create_consensus_mission",
  command_id: "00000000-0000-4000-8000-000000000011",
  mission_id: "00000000-0000-4000-8000-000000000012",
  repository_id: "00000000-0000-4000-8000-000000000013",
};

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "governed-source-closure-"));
  await mkdir(join(root, "application"));
  await mkdir(join(root, "domain"));
  const source = join(root, "application", "authority.ts");
  const schema = join(root, "domain", "mission-control-acceptance-source-manifest.schema.json");
  const manifestPath = join(root, "domain", "mission-control-acceptance-source-manifest.json");
  await writeFile(source, "export const authority = 'bounded';\n");
  await writeFile(schema, "{}\n");
  const manifest = {
    schemaVersion: "mission-control-acceptance-source-manifest/1",
    scope: "disposable_consensus_acceptance_security_boundary",
    sourceBase: "a".repeat(40),
    includedRoots: ["application", "domain"],
    includedFiles: [],
    excludedFiles: ["domain/mission-control-acceptance-source-manifest.json"],
    files: {
      "application/authority.ts": sha256(await readFile(source, "utf8")),
      "domain/mission-control-acceptance-source-manifest.schema.json": sha256(await readFile(schema, "utf8")),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const artifact = {
    sourceCommit: manifest.sourceBase,
    acceptanceSourceManifestSha256: sha256(await readFile(manifestPath, "utf8")),
    acceptanceSourceManifestCanonicalSha256: canonicalHash(manifest),
    acceptanceSourceManifestSchemaSha256: sha256(await readFile(schema, "utf8")),
  };
  return { root, source, manifestPath, artifact };
}

export async function executeSourceClosureMutationMatrix() {
  const mutations = [
    [
      "changed_file",
      async (fixture: Awaited<ReturnType<typeof sourceFixture>>) => writeFile(fixture.source, "changed\n"),
    ],
    [
      "added_file",
      async (fixture: Awaited<ReturnType<typeof sourceFixture>>) =>
        writeFile(join(fixture.root, "application", "added.ts"), "export {};\n"),
    ],
    ["deleted_file", async (fixture: Awaited<ReturnType<typeof sourceFixture>>) => unlink(fixture.source)],
    [
      "symlink_substitution",
      async (fixture: Awaited<ReturnType<typeof sourceFixture>>) => {
        await unlink(fixture.source);
        await symlink(fixture.manifestPath, fixture.source);
      },
    ],
    [
      "file_type_substitution",
      async (fixture: Awaited<ReturnType<typeof sourceFixture>>) => {
        await unlink(fixture.source);
        await mkdir(fixture.source);
      },
    ],
  ] as const;
  const cases = [];
  let sourceManifestSha256 = "";
  for (const [mutationKind, mutate] of mutations) {
    const fixture = await sourceFixture();
    try {
      sourceManifestSha256 = fixture.artifact.acceptanceSourceManifestSha256;
      const approved = loadApprovedAcceptanceSource(fixture.artifact as never, fixture.root);
      const sourceStateBeforeSha256 = canonicalHash(approved.manifest);
      await mutate(fixture);
      const mutatedSourceStateSha256 = canonicalHash({
        mutationKind,
        sourceBytes: await readFile(fixture.source).catch(() => Buffer.from("missing")),
        entries: await readFile(fixture.manifestPath, "utf8"),
      });
      let protectedActionInvocations = 0;
      let evidence;
      let actualRejectionCode;
      try {
        const controller = new AcceptanceSourceCheckpointController(approved, randomUUID(), (item) => {
          evidence = item;
        });
        controller.run("before_mission_creation", sourceBinding, () => {
          protectedActionInvocations += 1;
        });
        throw new Error("Mutated acceptance source unexpectedly reached its protected action");
      } catch (error) {
        if (!(error instanceof AcceptanceSourceClosureFailure)) throw error;
        actualRejectionCode = error.reasonCode;
      }
      if (!actualRejectionCode) throw new Error(`Source mutation unexpectedly succeeded: ${mutationKind}`);
      cases.push({
        mutationKind,
        actualRejectionCode,
        sourceStateBeforeSha256,
        mutatedSourceStateSha256,
        protectedActionInvocations,
        evidence,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
  return { sourceManifestSha256, cases };
}

export async function executeCheckpointMisuseMatrix() {
  const fixture = await sourceFixture();
  try {
    const approved = loadApprovedAcceptanceSource(fixture.artifact as never, fixture.root);
    const acceptanceRunId = randomUUID();
    let checkpoint;
    const controller = new AcceptanceSourceCheckpointController(approved, acceptanceRunId, (item) => {
      checkpoint = item;
    });
    let protectedActionInvocations = 0;
    controller.run("before_mission_creation", sourceBinding, () => {
      protectedActionInvocations += 1;
    });
    if (!checkpoint) throw new Error("Governed checkpoint was not persisted");
    const durableState = canonicalHash({ checkpoint, protectedActionInvocations });
    const attempts = [
      ["wrong_run", () => controller.consume(checkpoint!, "before_mission_creation", randomUUID())],
      [
        "wrong_candidate",
        () => {
          const other = new AcceptanceSourceCheckpointController(approved, acceptanceRunId, () => undefined, {
            artifact_sha256: "1".repeat(64),
            capability_manifest_sha256: "2".repeat(64),
            registry_content_sha256: "3".repeat(64),
            acceptance_contract_canonical_sha256: "4".repeat(64),
          });
          other.consume(checkpoint!, "before_mission_creation", acceptanceRunId);
        },
      ],
      ["wrong_phase", () => controller.consume(checkpoint!, "before_human_approval", acceptanceRunId)],
      [
        "wrong_action",
        () => {
          const other = new AcceptanceSourceCheckpointController(approved, acceptanceRunId, () => undefined);
          other.consume(checkpoint!, "before_mission_creation", acceptanceRunId);
        },
      ],
      ["reuse", () => controller.consume(checkpoint!, "before_mission_creation", acceptanceRunId)],
      [
        "stale_identity",
        () =>
          controller.consume(
            { ...checkpoint!, checkpoint_id: randomUUID() },
            "before_mission_creation",
            acceptanceRunId,
          ),
      ],
    ] as const;
    const cases = attempts.map(([misuseKind, attempt]) => {
      let actualRejectionCode;
      try {
        attempt();
      } catch (error) {
        if (!(error instanceof AcceptanceSourceCheckpointRejection)) throw error;
        actualRejectionCode = error.reasonCode;
      }
      if (!actualRejectionCode) throw new Error(`Checkpoint misuse unexpectedly succeeded: ${misuseKind}`);
      return {
        misuseKind,
        checkpointId: checkpoint!.checkpoint_id,
        bindingSha256: checkpoint!.binding_hash,
        acceptanceRunId,
        candidateBindingSha256: canonicalHash(checkpoint!.authority_binding),
        checkpointPhase: checkpoint!.checkpoint,
        protectedAction: checkpoint!.action_binding.action,
        actualRejectionCode,
        protectedActionInvocations: 0,
        durableStateBeforeSha256: durableState,
        durableStateAfterSha256: durableState,
      };
    });
    return { sourceManifestSha256: fixture.artifact.acceptanceSourceManifestSha256, cases };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function observeDisposableDatabaseIsolation(input: {
  acceptanceRunId: string;
  candidateIdentitySha256: string;
  databaseResourceInventoryId: string;
  connectionConfiguration: Record<string, unknown>;
  connectDisposable: () => Promise<void>;
  connectionAttempts: () => number;
}) {
  const trust = runtimeTrustEvidence();
  if (
    trust.runtimeMode !== "disposable_acceptance" ||
    trust.productionResourcesAllowed !== false ||
    !trust.databaseIdentity
  )
    throw new Error("Disposable database isolation requires governed disposable runtime trust");
  await input.connectDisposable();
  const actualDatabaseIdentitySha256 = trust.databaseIdentity;
  const forbiddenDatabaseIdentitySha256 = canonicalHash({
    classification: "production",
    representation: "local-production-database-descriptor",
  });
  const before = input.connectionAttempts();
  let rejection;
  try {
    evaluateResourceAuthority({
      commandId: randomUUID(),
      acceptanceRunId: input.acceptanceRunId,
      candidateIdentitySha256: input.candidateIdentitySha256,
      workspaceId: input.acceptanceRunId,
      missionId: null,
      actorId: "disposable-database-isolation",
      resourceType: "database",
      resourceClassification: "production",
      operation: "connect",
      resourceIdentity: "local-production-database-descriptor",
      requestedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    rejection = { code: error.code, reasonCode: error.details?.reason_code };
  }
  if (!rejection) throw new Error("Forbidden database target unexpectedly passed startup authority");
  return {
    runtimeMode: trust.runtimeMode,
    productionAuthority: trust.productionResourcesAllowed,
    expectedDatabaseIdentitySha256: trust.databaseIdentity,
    actualDatabaseIdentitySha256,
    forbiddenDatabaseIdentitySha256,
    databaseResourceInventoryId: input.databaseResourceInventoryId,
    connectionConfigurationIdentity: canonicalHash(input.connectionConfiguration),
    databaseScope: "disposable",
    acceptedDisposableTargetResult: "accepted",
    forbiddenTargetResult: "rejected_before_connection",
    actualTopLevelErrorCode: rejection.code,
    actualRejectionCode: rejection.reasonCode,
    connectionAttemptsBeforeForbidden: before,
    connectionAttemptsAfterForbidden: input.connectionAttempts(),
    productionEndpointContacted: false,
  } as const;
}
