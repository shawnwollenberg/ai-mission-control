import { access, constants, realpath } from "node:fs/promises";
import path from "node:path";
import { getDatabasePool } from "@/lib/database";
import { assertSupportedNodeVersion } from "@/lib/runtime-version";

export type ProcessType =
  | "web"
  | "generic"
  | "codex"
  | "action"
  | "remote_delivery"
  | "hermes_bridge"
  | "scheduler"
  | "notification"
  | "migration"
  | "backup";
export type ConfigurationCheck = { name: string; ok: boolean; summary: string; required: boolean };
const secretNames = new Set([
  "MISSION_CONTROL_SESSION_SECRET",
  "DATABASE_URL",
  "ARTIFACT_S3_ACCESS_KEY_ID",
  "ARTIFACT_S3_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "HERMES_AGENT_SECRET",
]);
function configured(name: string, minimum = 1) {
  return typeof process.env[name] === "string" && process.env[name]!.length >= minimum;
}
function check(name: string, ok: boolean, summary: string, required = true): ConfigurationCheck {
  return { name, ok, summary, required };
}

export async function pendingMigrations() {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(path.resolve(process.cwd(), "db/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = await getDatabasePool().query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
  const names = new Set(applied.rows.map((row) => row.name));
  return files.filter((name) => !names.has(name));
}
export async function validateProductionConfiguration(
  processType: ProcessType,
  options: { requireCurrentSchema?: boolean } = {},
) {
  const production = process.env.APP_ENV === "production";
  const checks: ConfigurationCheck[] = [];
  try {
    assertSupportedNodeVersion();
    checks.push(check("node", true, `Supported Node ${process.versions.node}`));
  } catch {
    checks.push(check("node", false, "Node 22.20 or newer in major version 22 is required"));
  }
  checks.push(
    check(
      "environment",
      ["local", "test", "production"].includes(process.env.APP_ENV ?? ""),
      "APP_ENV is explicitly local, test, or production",
    ),
  );
  checks.push(
    check("database_configuration", configured("DATABASE_URL"), "Dedicated database connection is configured"),
  );
  if (configured("DATABASE_URL")) {
    try {
      await getDatabasePool().query("SELECT 1");
      checks.push(check("database_connectivity", true, "Database connection succeeded"));
    } catch {
      checks.push(check("database_connectivity", false, "Database connection failed"));
    }
  }
  if (options.requireCurrentSchema && configured("DATABASE_URL")) {
    try {
      const pending = await pendingMigrations();
      checks.push(
        check(
          "migrations",
          pending.length === 0,
          pending.length ? `${pending.length} migrations are pending` : "Database schema is current",
        ),
      );
    } catch {
      checks.push(check("migrations", false, "Migration status could not be verified"));
    }
  }
  if (processType === "web") {
    checks.push(
      check(
        "session_key",
        configured("MISSION_CONTROL_SESSION_SECRET", 32),
        "Session signing key is configured with sufficient length",
      ),
    );
    const origin = process.env.PUBLIC_APP_URL;
    checks.push(
      check(
        "public_origin",
        !!origin && (!production || origin.startsWith("https://")),
        production ? "Production origin uses HTTPS" : "Public origin is configured",
      ),
    );
    checks.push(
      check(
        "secure_cookies",
        !production || process.env.SECURE_COOKIES === "true",
        "Secure-cookie mode matches the environment",
      ),
    );
  }
  if (
    ["generic", "codex", "action", "remote_delivery", "hermes_bridge", "scheduler", "notification"].includes(
      processType,
    )
  )
    checks.push(check("worker_identity", configured("WORKER_ID"), "Stable worker identity is configured"));
  if (processType === "codex") {
    checks.push(check("codex_executable", configured("CODEX_EXECUTABLE"), "Codex executable is explicitly configured"));
    checks.push(
      check("codex_authentication", configured("CODEX_API_KEY", 20), "Single-run Codex authentication is configured"),
    );
    checks.push(
      check(
        "repository_roots",
        configured("APPROVED_REPOSITORY_ROOTS"),
        "Approved repository roots are explicitly configured",
      ),
    );
    checks.push(check("worktree_root", configured("CODEX_WORKTREE_ROOT"), "Isolated worktree storage is configured"));
    if (configured("CODEX_WORKTREE_ROOT"))
      try {
        const root = await realpath(process.env.CODEX_WORKTREE_ROOT!);
        await access(root, constants.W_OK);
        checks.push(check("worktree_writable", true, "Worktree root is writable"));
      } catch {
        checks.push(check("worktree_writable", false, "Worktree root is unavailable or not writable"));
      }
  }
  const needsArtifacts = ["web", "codex"].includes(processType);
  if (needsArtifacts) {
    const provider = process.env.ARTIFACT_STORAGE_PROVIDER;
    checks.push(
      check(
        "artifact_provider",
        provider === "s3" || (!production && provider === "local"),
        production ? "Production object storage provider is configured" : "Artifact provider is configured",
      ),
    );
    if (provider === "s3")
      for (const name of [
        "ARTIFACT_S3_BUCKET",
        "ARTIFACT_S3_REGION",
        "ARTIFACT_S3_ENDPOINT",
        "ARTIFACT_S3_ACCESS_KEY_ID",
        "ARTIFACT_S3_SECRET_ACCESS_KEY",
      ])
        checks.push(
          check(
            `artifact_${name.toLowerCase()}`,
            configured(name),
            `${secretNames.has(name) ? "Credential" : "Setting"} ${name} is configured`,
          ),
        );
  }
  checks.push(check("secret_provider", configured("SECRET_PROVIDER"), "Secret provider is explicitly identified"));
  if (["remote_delivery", "hermes_bridge"].includes(processType))
    checks.push(
      check(
        "agent_credential_provider",
        configured("AGENT_CREDENTIAL_PROVIDER"),
        "Agent credential provider is configured",
      ),
    );
  if (["action", "codex"].includes(processType))
    checks.push(check("git_provider", configured("GIT_PROVIDER"), "Git provider is configured"));
  if (processType === "notification")
    checks.push(
      check("notification_provider", configured("NOTIFICATION_PROVIDER"), "Notification provider is configured"),
    );
  if (processType === "backup") {
    checks.push(check("backup_provider", configured("BACKUP_PROVIDER"), "Backup provider is configured"));
    checks.push(
      check(
        "point_in_time_recovery",
        process.env.BACKUP_PITR_ENABLED === "true",
        "Point-in-time recovery is explicitly enabled",
      ),
    );
  }
  const failed = checks.filter((item) => item.required && !item.ok);
  return {
    processType,
    environment: process.env.APP_ENV ?? "unset",
    ready: failed.length === 0,
    checks,
    failed: failed.map((item) => item.name),
  };
}
export function safeConfigurationReport(result: Awaited<ReturnType<typeof validateProductionConfiguration>>) {
  return { ...result, checks: result.checks.map((item) => ({ ...item })), secretsPrinted: false };
}
