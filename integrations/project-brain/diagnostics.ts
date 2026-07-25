import path from "node:path";
import { access, constants, realpath } from "node:fs/promises";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { runSafeProcess } from "@/execution/safe-process";
import { ProjectBrainClient, ProjectBrainAdapterError } from "./client";
import { getProjectBrainConfiguration } from "./config";

export type ProjectBrainDiagnosticReport = {
  ready: boolean;
  coreVersion?: string;
  adapterVersion?: string;
  contractVersion?: string;
  schemaVersions?: string[];
  schemaCount?: number;
  implementationDrift?: string[];
  failure?: string;
};

export type ProjectBrainDependencyReport = {
  ready: boolean;
  repositoryRootReady: boolean;
  artifactStorageReady: boolean;
  failure?: "repository_root_unavailable" | "artifact_storage_unavailable";
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectBrainAdapterError("Project Brain diagnostic response is invalid", "invalid_response");
  return value as Record<string, unknown>;
}

export async function diagnoseProjectBrainRuntime(
  repositoryPath = process.cwd(),
): Promise<ProjectBrainDiagnosticReport> {
  const configuration = getProjectBrainConfiguration();
  if (!configuration.enabled) return { ready: false, failure: configuration.status };
  const root = path.resolve(repositoryPath);
  const runtimeEnv = process.env.PROJECT_BRAIN_SKILL_PATH
    ? { PROJECT_BRAIN_SKILL_PATH: process.env.PROJECT_BRAIN_SKILL_PATH }
    : undefined;
  try {
    const doctorProcess = await runSafeProcess({
      executable: configuration.executable,
      args: ["doctor", "--format", "json"],
      cwd: root,
      allowedRoot: root,
      env: runtimeEnv,
      timeoutMs: configuration.timeoutMs,
      maxOutputBytes: configuration.maxOutputBytes,
    });
    if (doctorProcess.exitCode !== 0 || doctorProcess.timedOut)
      throw new ProjectBrainAdapterError("Project Brain doctor failed", "invalid_response");
    const doctor = object(JSON.parse(doctorProcess.stdout));
    const schemaAvailability = object(doctor.schema_availability);
    const implementationDrift = Array.isArray(doctor.implementation_drift)
      ? doctor.implementation_drift.map(String)
      : ["invalid_drift_report"];
    const client = new ProjectBrainClient({ ...configuration, env: runtimeEnv });
    const capabilities = await client.capabilities(root);
    const schemaVersions = capabilities.supported_artifact_schema_versions;
    const ready =
      doctor.core_package_version === configuration.requiredVersion &&
      doctor.skill_adapter_version === configuration.requiredVersion &&
      doctor.versions_compatible === true &&
      doctor.mode === "ready" &&
      schemaAvailability.available === true &&
      schemaAvailability.count === 13 &&
      implementationDrift.length === 0 &&
      schemaVersions.includes("2.5.0") &&
      capabilities.consumer_contract_versions.includes(configuration.contractVersion) &&
      capabilities.adapter_compatibility.compatible === true;
    return {
      ready,
      coreVersion: String(doctor.core_package_version ?? ""),
      adapterVersion: String(doctor.skill_adapter_version ?? ""),
      contractVersion: configuration.contractVersion,
      schemaVersions,
      schemaCount: Number(schemaAvailability.count ?? 0),
      implementationDrift,
      ...(ready ? {} : { failure: "incompatible_runtime" }),
    };
  } catch (error) {
    return {
      ready: false,
      failure: error instanceof ProjectBrainAdapterError ? error.classification : "diagnostics_failed",
    };
  }
}

export function safeProjectBrainDiagnosticReport(report: ProjectBrainDiagnosticReport) {
  return {
    event: "project_brain_runtime_diagnostic",
    ready: report.ready,
    coreVersion: report.coreVersion,
    adapterVersion: report.adapterVersion,
    contractVersion: report.contractVersion,
    schemaVersions: report.schemaVersions,
    schemaCount: report.schemaCount,
    implementationDrift: report.implementationDrift,
    failure: report.failure,
    secretsPrinted: false,
  };
}

export async function diagnoseProjectBrainDependencies(): Promise<ProjectBrainDependencyReport> {
  const repositoryRoot = process.env.CODEX_REPOSITORY_ROOT;
  try {
    if (!repositoryRoot || !path.isAbsolute(repositoryRoot)) throw new Error("invalid root");
    const resolved = await realpath(repositoryRoot);
    await access(resolved, constants.R_OK | constants.X_OK);
  } catch {
    return {
      ready: false,
      repositoryRootReady: false,
      artifactStorageReady: false,
      failure: "repository_root_unavailable",
    };
  }
  try {
    const endpoint = process.env.ARTIFACT_S3_ENDPOINT;
    const accessKeyId = process.env.ARTIFACT_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.ARTIFACT_S3_SECRET_ACCESS_KEY;
    const client = new S3Client({
      region: process.env.ARTIFACT_S3_REGION,
      ...(endpoint ? { endpoint, forcePathStyle: !endpoint.includes("amazonaws.com") } : {}),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
    await client.send(new HeadBucketCommand({ Bucket: process.env.ARTIFACT_S3_BUCKET }));
  } catch {
    return {
      ready: false,
      repositoryRootReady: true,
      artifactStorageReady: false,
      failure: "artifact_storage_unavailable",
    };
  }
  return { ready: true, repositoryRootReady: true, artifactStorageReady: true };
}

export function safeProjectBrainDependencyReport(report: ProjectBrainDependencyReport) {
  return {
    event: "project_brain_dependency_diagnostic",
    ready: report.ready,
    repositoryRootReady: report.repositoryRootReady,
    artifactStorageReady: report.artifactStorageReady,
    failure: report.failure,
    secretsPrinted: false,
  };
}
