import { access, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runSafeProcess } from "@/execution/safe-process";
import {
  projectBrainContractVersion,
  type ProjectBrainCapabilities,
  type ProjectBrainEnvelope,
  type ProjectBrainOperation,
  type ProjectBrainResult,
} from "./types";

export class ProjectBrainAdapterError extends Error {
  constructor(
    message: string,
    readonly classification:
      | "not_installed"
      | "timeout"
      | "output_limit"
      | "invalid_response"
      | "incompatible_contract"
      | "operation_failed",
    readonly envelope?: ProjectBrainEnvelope,
  ) {
    super(message);
  }
}

const operations = new Set<ProjectBrainOperation>([
  "detect_repository",
  "validate_repository",
  "get_summary",
  "prepare_context",
  "read_context",
  "record_closure",
  "propose_learning",
  "evaluate_learning",
  "get_curation",
  "list_knowledge",
  "get_health",
  "diagnostics",
]);

function parseObject(output: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new ProjectBrainAdapterError("Project Brain returned malformed JSON", "invalid_response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectBrainAdapterError("Project Brain returned a non-object response", "invalid_response");
  return value as Record<string, unknown>;
}

function envelope<T>(value: Record<string, unknown>, expectedOperation: ProjectBrainOperation): ProjectBrainEnvelope<T> {
  const stringArray = (candidate: unknown) =>
    Array.isArray(candidate) && candidate.every((item) => typeof item === "string");
  const repository = value.repository;
  const repositoryValid =
    repository === null ||
    (typeof repository === "object" &&
      !Array.isArray(repository) &&
      typeof (repository as Record<string, unknown>).id === "string" &&
      typeof (repository as Record<string, unknown>).checkout_path === "string" &&
      typeof (repository as Record<string, unknown>).head_sha === "string");
  const artifactsValid =
    Array.isArray(value.artifacts) &&
    value.artifacts.every(
      (artifact) =>
        artifact &&
        typeof artifact === "object" &&
        typeof (artifact as Record<string, unknown>).kind === "string" &&
        typeof (artifact as Record<string, unknown>).path === "string" &&
        typeof (artifact as Record<string, unknown>).sha256 === "string" &&
        typeof (artifact as Record<string, unknown>).schema_version === "string",
    );
  if (
    value.contract_version !== projectBrainContractVersion ||
    value.operation !== expectedOperation ||
    !["succeeded", "failed"].includes(String(value.status)) ||
    !repositoryValid ||
    !artifactsValid ||
    !stringArray(value.warnings) ||
    !stringArray(value.blockers) ||
    !stringArray(value.required_actions) ||
    typeof value.human_approval_required !== "boolean" ||
    typeof value.repository_files_changed !== "boolean" ||
    typeof value.exit_classification !== "string" ||
    !("data" in value)
  )
    throw new ProjectBrainAdapterError("Project Brain returned an invalid consumer envelope", "invalid_response");
  return value as ProjectBrainEnvelope<T>;
}

export class ProjectBrainClient {
  constructor(
    private readonly config: {
      executable: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
      env?: Record<string, string>;
    },
  ) {}

  private async invoke(args: string[], repositoryPath: string) {
    try {
      await access(this.config.executable);
    } catch {
      throw new ProjectBrainAdapterError("Project Brain executable is not installed", "not_installed");
    }
    const result = await runSafeProcess({
      executable: this.config.executable,
      args,
      cwd: repositoryPath,
      allowedRoot: repositoryPath,
      env: this.config.env,
      timeoutMs: this.config.timeoutMs ?? 15_000,
      maxOutputBytes: this.config.maxOutputBytes ?? 1_000_000,
    });
    if (result.timedOut) throw new ProjectBrainAdapterError("Project Brain request timed out", "timeout");
    if (Buffer.byteLength(result.stdout) >= (this.config.maxOutputBytes ?? 1_000_000))
      throw new ProjectBrainAdapterError("Project Brain response exceeded the output limit", "output_limit");
    return { result, parsed: parseObject(result.stdout) };
  }

  private async head(repositoryPath: string): Promise<string | null> {
    const result = await runSafeProcess({
      executable: "/usr/bin/git",
      args: ["rev-parse", "HEAD"],
      cwd: repositoryPath,
      allowedRoot: repositoryPath,
      timeoutMs: 5_000,
      maxOutputBytes: 256,
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async capabilities(repositoryPath: string): Promise<ProjectBrainCapabilities> {
    const { parsed } = await this.invoke(["capabilities", "--json"], repositoryPath);
    const supported = parsed.consumer_contract_versions;
    if (!Array.isArray(supported) || !supported.includes(projectBrainContractVersion))
      throw new ProjectBrainAdapterError("Project Brain does not support consumer contract 1.0", "incompatible_contract");
    return parsed as ProjectBrainCapabilities;
  }

  async execute<T>(input: {
    workspaceId: string;
    repositoryId: string;
    repositoryPath: string;
    operation: ProjectBrainOperation;
    request?: Record<string, unknown>;
    missionId?: string;
    executionId?: string;
  }): Promise<ProjectBrainResult<T>> {
    if (!operations.has(input.operation))
      throw new ProjectBrainAdapterError("Project Brain operation is not allowlisted", "invalid_response");
    const started = Date.now();
    const startingSha = await this.head(input.repositoryPath);
    const { parsed, result: processResult } = await this.invoke(
      [
        "consumer",
        "--operation",
        input.operation,
        "--repo",
        input.repositoryPath,
        "--contract-version",
        projectBrainContractVersion,
        "--request-json",
        JSON.stringify(input.request ?? {}),
      ],
      input.repositoryPath,
    );
    const response = envelope<T>(parsed, input.operation);
    if (response.status === "succeeded") {
      if (!response.repository)
        throw new ProjectBrainAdapterError("Project Brain omitted repository identity", "invalid_response");
      const [returnedCheckout, requestedCheckout] = await Promise.all([
        realpath(String((response.repository as Record<string, unknown>).checkout_path)),
        realpath(input.repositoryPath),
      ]);
      if (
        returnedCheckout !== requestedCheckout ||
        (startingSha !== null && (response.repository as Record<string, unknown>).head_sha !== startingSha)
      )
        throw new ProjectBrainAdapterError(
          "Project Brain response does not match the requested checkout and starting revision",
          "invalid_response",
          response,
        );
    }
    if (response.contract_version !== projectBrainContractVersion)
      throw new ProjectBrainAdapterError("Project Brain returned an incompatible contract version", "incompatible_contract", response);
    const endingSha = await this.head(input.repositoryPath);
    const checksum = (text: string) => createHash("sha256").update(text).digest("hex");
    const auditEvent = {
      eventType: "project_brain.adapter_invoked" as const,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      operation: input.operation,
      contractVersion: response.contract_version,
      exitClassification: response.exit_classification,
      exitStatus: processResult.exitCode,
      argumentKeys: Object.keys(input.request ?? {}).sort(),
      startingSha,
      endingSha,
      durationMs: Date.now() - started,
      artifactReferences: response.artifacts
        .map((artifact) => artifact.path)
        .filter((path): path is string => typeof path === "string"),
      artifactChecksums: response.artifacts
        .map((artifact) => artifact.sha256)
        .filter((value): value is string => typeof value === "string"),
      stdoutSha256: checksum(processResult.stdout),
      stderrSha256: checksum(processResult.stderr),
    };
    if (response.status !== "succeeded")
      throw new ProjectBrainAdapterError(
        response.blockers[0] ?? "Project Brain operation failed",
        "operation_failed",
        response,
      );
    return { envelope: response, auditEvent };
  }
}
