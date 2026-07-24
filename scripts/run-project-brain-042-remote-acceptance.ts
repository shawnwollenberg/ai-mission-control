import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { once } from "node:events";
import { getDatabasePool, closeDatabasePool } from "../lib/database";
import { registerRemoteAgent } from "../application/remote-agent-registry";
import { registerMissionAgentRepository } from "../application/registry";
import { requestProjectBrainOperation, requestProjectBrainWriteApproval } from "../application/project-brain-commands";
import { executeProjectBrainOperation } from "../integrations/project-brain/worker";
import { decideApproval } from "../application/approval-commands";
import { handleCreateMission } from "../application/mission-commands";
import { canonicalHash } from "../lib/canonical-json";
import { launchFirstRepositoryMission } from "../application/onboarding-mission";
import type { ProjectBrainOperation } from "../integrations/project-brain/types";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const projectBrainExecutable =
  process.env.PROJECT_BRAIN_ACCEPTANCE_EXECUTABLE ?? "/tmp/project-brain-042-venv/bin/project-brain";
const port = Number(process.env.PROJECT_BRAIN_ACCEPTANCE_PORT ?? 3137);
const baseUrl = `http://127.0.0.1:${port}`;
const workspaceId = randomUUID();
const ownerId = randomUUID();
const actor = { workspaceId, userId: ownerId, role: "owner" as const };
const pbActor = { workspaceId, id: ownerId, type: "human" as const };
const command = (cwd: string, binary: string, args: string[]) =>
  execFileSync(binary, args, { cwd, encoding: "utf8" }).trim();
const waitFor = async <T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("Acceptance wait timed out");
};

async function main() {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "project-brain-042-remote-checkout-")));
  const agentHome = await mkdtemp(join(tmpdir(), "project-brain-042-agent-"));
  const artifactStorageRoot = await realpath(await mkdtemp(join(tmpdir(), "project-brain-042-artifacts-")));
  process.env.ARTIFACT_STORAGE_ROOT = artifactStorageRoot;
  command(checkout, "git", ["init", "-q", "-b", "main"]);
  command(checkout, "git", ["config", "user.email", "acceptance@example.com"]);
  command(checkout, "git", ["config", "user.name", "Remote Acceptance"]);
  await writeFile(join(checkout, "README.md"), "# Remote acceptance\n");
  await writeFile(join(checkout, "app.js"), "export const value = 1;\n");
  command(checkout, "git", ["add", "."]);
  command(checkout, "git", ["commit", "-qm", "initial"]);
  const initialSha = command(checkout, "git", ["rev-parse", "HEAD"]);
  const fingerprint = createHash("sha256")
    .update(`local:${checkout}\n${basename(checkout)}`)
    .digest("hex");

  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)", [
    workspaceId,
    `pb-042-${workspaceId}`,
    "Project Brain 0.4.2 Acceptance",
  ]);
  const registration = await registerRemoteAgent({
    actor,
    name: "Project Brain 0.4.2 Remote Acceptance",
    endpoint: "https://pull.invalid/messages",
    capabilities: ["repository.read", "repository.write", "code.review", "artifact.create", "test.run"],
    supportedDomains: ["software_delivery"],
    deliveryMode: "pull",
    missionAgentAdapter: "codex",
  });
  const repository = await registerMissionAgentRepository({
    workspaceId,
    agentId: registration.agentId,
    name: basename(checkout),
    fingerprint,
    defaultBranch: "main",
    commit: initialSha,
  });
  await getDatabasePool().query(
    `UPDATE repositories SET project_brain_enabled=true,read_allowed=true,write_allowed=true,
       commit_allowed=true WHERE workspace_id=$1 AND repository_id=$2`,
    [workspaceId, repository.repository_id],
  );
  await getDatabasePool().query(
    `UPDATE agent_resource_permissions SET permissions='["read","write"]'::jsonb
     WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3`,
    [workspaceId, registration.agentId, repository.repository_id],
  );
  await writeFile(
    join(agentHome, "config.json"),
    JSON.stringify({
      missionControlUrl: baseUrl,
      workspaceId,
      workspaceName: "Project Brain 0.4.2 Acceptance",
      agentId: registration.agentId,
      agentName: "Project Brain 0.4.2 Remote Acceptance",
      credentialId: registration.credential.credentialId,
      secret: registration.credential.secret,
      secretStorage: "file-0600",
      adapter: "codex",
      capabilities: ["repository.read", "repository.write", "code.review", "artifact.create", "test.run"],
      leaseOwner: `acceptance-${randomUUID()}`,
      projectBrainExecutable,
      repositories: {
        [repository.repository_id]: {
          path: checkout,
          name: basename(checkout),
          branch: "main",
          commit: initialSha,
          fingerprint,
          projectBrainWriteAllowed: true,
        },
      },
    }),
    { mode: 0o600 },
  );
  await chmod(join(agentHome, "config.json"), 0o600);

  const server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: resolve("."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => (serverLog += chunk));
  server.stderr.on("data", (chunk) => (serverLog += chunk));
  await waitFor(async () => {
    try {
      return (await fetch(`${baseUrl}/api/health`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
  const agent = spawn(process.execPath, [resolve("public/mission-agent-0.6.7.mjs"), "run"], {
    env: { ...process.env, MISSION_AGENT_HOME: agentHome, MISSION_AGENT_DEBUG_REQUEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let agentLog = "";
  agent.stdout.on("data", (chunk) => (agentLog += chunk));
  agent.stderr.on("data", (chunk) => (agentLog += chunk));

  try {
    await waitFor(async () => {
      const row = (
        await getDatabasePool().query(
          "SELECT remote_project_brain_capabilities_at FROM agents WHERE workspace_id=$1 AND agent_id=$2",
          [workspaceId, registration.agentId],
        )
      ).rows[0];
      return row?.remote_project_brain_capabilities_at ? true : undefined;
    });
    const mission = await handleCreateMission({
      actor,
      commandId: randomUUID(),
      mission: {
        name: "Remote Project Brain acceptance",
        objective: "Complete the real remote Project Brain lifecycle",
        domain: "software_delivery",
        priority: "normal",
        riskLevel: "moderate",
        successCriteria: ["Remote authoritative artifacts are versioned and returned"],
        constraints: ["No push, merge, publication, or deployment"],
      },
    });

    const runOperation = async (
      operation: ProjectBrainOperation,
      args: Record<string, unknown>,
      write: boolean,
      missionId: string | undefined = mission.missionId,
      executionId?: string,
    ) => {
      const current = (
        await getDatabasePool().query<{ observed_commit: string }>(
          "SELECT observed_commit FROM repositories WHERE workspace_id=$1 AND repository_id=$2",
          [workspaceId, repository.repository_id],
        )
      ).rows[0].observed_commit;
      const base = {
        repositoryId: repository.repository_id,
        missionId,
        executionId,
        operation,
        arguments: args,
        startingSha: current,
      };
      let approvalId: string | undefined;
      if (write) {
        const approval = await requestProjectBrainWriteApproval({ actor: pbActor, request: base });
        approvalId = approval.approvalId;
        await decideApproval({
          workspaceId,
          approvalId,
          granted: true,
          actorId: ownerId,
          reason: "Disposable 0.4.2 acceptance",
        });
      }
      const requested = await requestProjectBrainOperation({
        actor: pbActor,
        request: { ...base, approvalId, idempotencyKey: randomUUID() },
      });
      await executeProjectBrainOperation({
        workspaceId,
        operationId: requested.operationId,
        workerId: "project-brain-042-acceptance",
      });
      return waitFor(async () => {
        const row = (
          await getDatabasePool().query<{ status: string; ending_sha: string | null; failure_cause: string | null }>(
            `SELECT status,ending_sha,failure_cause FROM project_brain_operation_projections
             WHERE workspace_id=$1 AND operation_id=$2`,
            [workspaceId, requested.operationId],
          )
        ).rows[0];
        if (row?.status === "succeeded") return row;
        if (["failed", "denied"].includes(row?.status))
          throw new Error(`Operation ${operation} ${row.status}: ${row.failure_cause ?? "no cause"}`);
        return undefined;
      }, 60_000);
    };

    await runOperation("initialize_repository", { repository_id: repository.repository_id }, true, mission.missionId);
    await runOperation("validate_repository", {}, false);
    await runOperation(
      "prepare_context",
      { objective: "Make a safe real code change", role: "implementer", preview: true, write: false },
      false,
    );
    const previewEvidence = (
      await getDatabasePool().query<{
        selected_source_manifest: Array<Record<string, unknown>>;
        context_quality: Record<string, unknown>;
      }>(
        `SELECT selected_source_manifest,context_quality FROM mission_project_brain_projections
         WHERE workspace_id=$1 AND mission_id=$2`,
        [workspaceId, mission.missionId],
      )
    ).rows[0];
    if (
      !previewEvidence ||
      !Array.isArray(previewEvidence.selected_source_manifest) ||
      previewEvidence.selected_source_manifest.length === 0 ||
      Number(previewEvidence.context_quality.final_selected_files ?? 0) === 0
    )
      throw new Error("Remote context preview did not expose selected-source and quality metrics");
    const codingMission = await launchFirstRepositoryMission({
      actor,
      commandId: randomUUID(),
      agentId: registration.agentId,
      repositoryId: repository.repository_id,
      missionType: "change",
      objective: "Change app.js exported value from 1 to 2",
      acceptanceCriteria: "app.js exports the numeric value 2",
    });
    const context = await runOperation(
      "prepare_context",
      {
        objective: "Make a safe real code change",
        role: "implementer",
        preview: false,
        write: true,
        mission_id: codingMission.missionId,
        execution_id: codingMission.executionId,
        output: `.project-brain/context-packs/${codingMission.missionId}.yaml`,
      },
      true,
      codingMission.missionId,
      codingMission.executionId,
    );
    const codeStartSha = context.ending_sha!;
    const executionApproval = await waitFor(async () => {
      const row = (
        await getDatabasePool().query<{ approval_id: string }>(
          `SELECT approval_id FROM approval_projections
           WHERE workspace_id=$1 AND execution_id=$2 AND status='pending'
           ORDER BY created_at DESC LIMIT 1`,
          [workspaceId, codingMission.executionId],
        )
      ).rows[0];
      return row?.approval_id;
    }, 120_000);
    await decideApproval({
      workspaceId,
      approvalId: executionApproval,
      granted: true,
      actorId: ownerId,
      reason: "Approve isolated disposable acceptance change",
    });
    const execution = await waitFor(async () => {
      const row = (
        await getDatabasePool().query<{
          status: string;
          base_commit: string | null;
          commit_id: string | null;
          output_summary: string | null;
        }>(
          `SELECT status,base_commit,commit_id,output_summary FROM execution_projections
           WHERE workspace_id=$1 AND execution_id=$2`,
          [workspaceId, codingMission.executionId],
        )
      ).rows[0];
      if (row?.status === "succeeded") return row;
      if (["failed", "timed_out", "cancelled"].includes(row?.status)) throw new Error(`Coding execution ${row.status}`);
      return undefined;
    }, 300_000);
    const codeEndSha = execution.commit_id!;
    if (!codeEndSha) throw new Error("Coding execution did not produce a commit");
    const closure = await runOperation(
      "record_closure",
      {
        objective: "Make a safe real code change",
        role: "implementer",
        agent: "mission-agent",
        status: "completed",
        start_sha: execution.base_commit ?? codeStartSha,
        end_sha: codeEndSha,
        acceptance_criterion: ["The deterministic value changes from 1 to 2"],
        acceptance_outcome: execution.output_summary ?? "Value changed and Git recorded the exact commit",
        evidence: [`.project-brain/context-packs/${codingMission.missionId}.yaml`],
        check: ["node-import=passed"],
        context_checksum: (
          await getDatabasePool().query<{ context_checksum: string }>(
            `SELECT context_checksum FROM mission_project_brain_projections
             WHERE workspace_id=$1 AND mission_id=$2`,
            [workspaceId, codingMission.missionId],
          )
        ).rows[0].context_checksum,
      },
      true,
      codingMission.missionId,
      codingMission.executionId,
    );
    const missionArtifact = (
      await getDatabasePool().query<{ repository_path: string }>(
        `SELECT repository_path FROM remote_project_brain_artifacts
         WHERE workspace_id=$1 AND repository_id=$2 AND kind='mission_result'
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, repository.repository_id],
      )
    ).rows[0].repository_path;
    await runOperation(
      "propose_learning",
      {
        mission_id: missionArtifact
          .split("/")
          .at(-1)!
          .replace(/\.yaml$/, ""),
        title: "Retain verified remote context continuity",
        claim: "Remote changes should consume the exact verified Project Brain context artifact.",
        scope: ["repository"],
        evidence: [`mission:${missionArtifact}`],
        proposer: "mission-control",
        future_behavior: "Verify the immutable context checksum before remote execution.",
      },
      true,
      codingMission.missionId,
      codingMission.executionId,
    );
    await runOperation(
      "evaluate_learning",
      { reviewer: "independent-review", output: `.project-brain/evaluations/${codingMission.missionId}.yaml` },
      true,
      codingMission.missionId,
      codingMission.executionId,
    );
    const evidence = (
      await getDatabasePool().query(
        `SELECT
          (SELECT count(*)::int FROM remote_project_brain_artifacts WHERE workspace_id=$1 AND repository_id=$2) artifacts,
          (SELECT count(*)::int FROM remote_project_brain_artifacts WHERE workspace_id=$1 AND repository_id=$2
            AND kind='proposed_learning') proposed_learnings,
          (SELECT count(*)::int FROM remote_project_brain_artifacts WHERE workspace_id=$1 AND repository_id=$2
            AND kind='knowledge_evaluation') evaluations,
          (SELECT count(*)::int FROM events WHERE workspace_id=$1
            AND event_type LIKE 'project_brain.%') canonical_events`,
        [workspaceId, repository.repository_id],
      )
    ).rows[0];
    const contextArtifact = (
      await getDatabasePool().query<{ sha256: string; content: Buffer; repository_path: string }>(
        `SELECT sha256,content,repository_path FROM remote_project_brain_artifacts
         WHERE workspace_id=$1 AND repository_id=$2 AND kind='context_pack'
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, repository.repository_id],
      )
    ).rows[0];
    const missionEvidence = (
      await getDatabasePool().query<{
        context_checksum: string;
        agent_received_checksum: string;
        agent_verified_checksum: string;
        agent_verification_status: string;
        closure_status: string;
        learning_proposal_status: string;
        evaluation_status: string;
      }>(
        `SELECT context_checksum,agent_received_checksum,agent_verified_checksum,
          agent_verification_status,closure_status,learning_proposal_status,evaluation_status
         FROM mission_project_brain_projections WHERE workspace_id=$1 AND mission_id=$2`,
        [workspaceId, codingMission.missionId],
      )
    ).rows[0];
    if (
      missionEvidence.context_checksum !== contextArtifact.sha256 ||
      missionEvidence.agent_received_checksum !== contextArtifact.sha256 ||
      missionEvidence.agent_verified_checksum !== contextArtifact.sha256 ||
      missionEvidence.agent_verification_status !== "verified"
    )
      throw new Error("Execution did not consume the exact verified remote context checksum");
    const learningInbox = (
      await getDatabasePool().query<{ kind: string; repository_path: string; content: Buffer }>(
        `SELECT kind,repository_path,content FROM remote_project_brain_artifacts
         WHERE workspace_id=$1 AND repository_id=$2 AND kind IN('proposed_learning','knowledge_evaluation')
         ORDER BY created_at`,
        [workspaceId, repository.repository_id],
      )
    ).rows;
    const promotionEvidence = (
      await getDatabasePool().query<{ confirmed_learning_count: number; confirmed_artifacts: number }>(
        `SELECT r.confirmed_learning_count,
          (SELECT count(*)::int FROM remote_project_brain_artifacts a
           WHERE a.workspace_id=r.workspace_id AND a.repository_id=r.repository_id
             AND a.kind='confirmed_learning') confirmed_artifacts
         FROM repository_project_brain_projections r
         WHERE r.workspace_id=$1 AND r.repository_id=$2`,
        [workspaceId, repository.repository_id],
      )
    ).rows[0];
    if (
      learningInbox.filter((item) => item.kind === "proposed_learning").length !== 1 ||
      learningInbox.filter((item) => item.kind === "knowledge_evaluation").length !== 1 ||
      !learningInbox.some(
        (item) =>
          item.kind === "proposed_learning" &&
          item.repository_path.includes("/lessons/proposed/") &&
          item.content.toString("utf8").includes("status: proposed"),
      ) ||
      Number(promotionEvidence?.confirmed_learning_count ?? 0) !== 0 ||
      Number(promotionEvidence?.confirmed_artifacts ?? 0) !== 0
    )
      throw new Error("Read-only learning inbox or no-automatic-promotion invariant failed");
    const lifecycleEvents = (
      await getDatabasePool().query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM events WHERE workspace_id=$1
         AND (event_type LIKE 'project_brain.%' OR event_type='agent.remote_project_brain_capability_advertised')
         ORDER BY event_type`,
        [workspaceId],
      )
    ).rows.map((row) => row.event_type);
    const requiredLifecycleEvents = [
      "agent.remote_project_brain_capability_advertised",
      "project_brain.remote_operation_dispatched",
      "project_brain.remote_operation_accepted",
      "project_brain.remote_operation_started",
      "project_brain.remote_artifact_received",
      "project_brain.remote_artifacts_versioned",
      "project_brain.remote_context_verified",
      "project_brain.context_verified_by_agent",
      "project_brain.closure_recorded",
      "project_brain.learning_proposed",
      "project_brain.learning_evaluated",
    ];
    if (requiredLifecycleEvents.some((eventType) => !lifecycleEvents.includes(eventType)))
      throw new Error("Disposable lifecycle is missing required canonical event semantics");
    const projectionReplay = JSON.parse(
      execFileSync(
        "npx",
        ["tsx", "scripts/projections.ts", "--verify", "--workspace", workspaceId, "--projection", "project-brain"],
        {
          cwd: resolve("."),
          env: { ...process.env, DATABASE_URL: databaseUrl },
          encoding: "utf8",
        },
      ).trim(),
    );
    if (projectionReplay.equal !== true)
      throw new Error("Disposable remote lifecycle projection replay did not match live state");
    console.log(
      JSON.stringify(
        {
          disposition: "remote_project_brain_artifact_lifecycle_passed",
          workspaceId,
          repositoryId: repository.repository_id,
          checkout,
          initialSha,
          codeStartSha,
          codeEndSha,
          closureEndingSha: closure.ending_sha,
          executionId: codingMission.executionId,
          context: {
            path: contextArtifact.repository_path,
            sha256: contextArtifact.sha256,
            bytes: contextArtifact.content.byteLength,
          },
          contextPreview: {
            selectedSources: previewEvidence.selected_source_manifest,
            quality: previewEvidence.context_quality,
          },
          contextContinuity: missionEvidence,
          learningInbox: learningInbox.map((item) => ({
            kind: item.kind,
            repositoryPath: item.repository_path,
          })),
          promotionEvidence,
          lifecycleEvents,
          ...evidence,
          projectionReplay,
          automaticPromotion: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const state = await readFile(join(agentHome, "state.json"), "utf8").catch(() => "unavailable");
    const requestDebug = await readFile(join(agentHome, "request-debug.json"), "utf8").catch(() => "unavailable");
    const centralRequest = (
      await getDatabasePool().query(
        "SELECT request FROM remote_project_brain_assignments WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1",
        [workspaceId],
      )
    ).rows[0]?.request;
    const centralUnsigned = { ...(centralRequest ?? {}) };
    delete centralUnsigned.requestChecksum;
    delete centralUnsigned.missionControlSignature;
    const transportedUnsigned = requestDebug === "unavailable" ? {} : JSON.parse(requestDebug);
    const differingKeys = Array.from(
      new Set([...Object.keys(centralUnsigned), ...Object.keys(transportedUnsigned)]),
    ).filter((key) => JSON.stringify(centralUnsigned[key]) !== JSON.stringify(transportedUnsigned[key]));
    throw new Error(
      `${error instanceof Error ? error.message : error}\nCHECKOUT: ${checkout}\nSTATE:\n${state}\nDIFFERING KEYS: ${differingKeys.join(",") || "none"}\nTRANSPORT:\n${requestDebug}\nCENTRAL RECOMPUTED: ${canonicalHash(centralUnsigned)}\nCENTRAL:\n${JSON.stringify(centralRequest, null, 2)}\nSERVER:\n${serverLog}\nAGENT:\n${agentLog}`,
    );
  } finally {
    agent.kill("SIGTERM");
    server.kill("SIGTERM");
    await Promise.all([once(agent, "exit").catch(() => undefined), once(server, "exit").catch(() => undefined)]);
    await getDatabasePool()
      .query("DELETE FROM events WHERE workspace_id=$1", [workspaceId])
      .catch(() => undefined);
    await getDatabasePool()
      .query("DELETE FROM workspaces WHERE id=$1", [workspaceId])
      .catch(() => undefined);
    await closeDatabasePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
