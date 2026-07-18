export type CommandClassification =
  | "read_only"
  | "build"
  | "test"
  | "file_modification"
  | "package_install"
  | "database_migration"
  | "destructive"
  | "infrastructure"
  | "secret_access"
  | "network_access"
  | "unknown";
const base = (value: string) => value.split("/").at(-1)!.toLowerCase();
export function classifyCommand(command: string[]): CommandClassification {
  if (!command.length) return "unknown";
  const executable = base(command[0]),
    args = command.slice(1).map((v) => v.toLowerCase()),
    joined = args.join(" ");
  if (["rm", "shred", "dd", "mkfs"].includes(executable) || (args.includes("--force") && executable === "git"))
    return "destructive";
  if (["terraform", "pulumi", "kubectl", "aws", "gcloud", "az"].includes(executable)) return "infrastructure";
  if (joined.includes(".env") || joined.includes("secret") || ["security"].includes(executable)) return "secret_access";
  if (["curl", "wget", "ssh", "scp", "nc"].includes(executable)) return "network_access";
  if (
    ["psql", "mysql", "prisma", "sequelize", "typeorm"].includes(executable) &&
    /(migrat|alter|drop|truncate)/.test(joined)
  )
    return "database_migration";
  if (
    ["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo"].includes(executable) &&
    args.some((a) => ["install", "add", "update"].includes(a))
  )
    return "package_install";
  if (args.includes("test") || joined.includes("--test") || /^(jest|vitest|pytest|playwright)$/.test(executable))
    return "test";
  if (
    args.some((a) => ["build", "lint", "format", "check"].includes(a)) ||
    ["tsc", "eslint", "prettier"].includes(executable)
  )
    return "build";
  if (["cat", "sed", "head", "tail", "rg", "grep", "find", "ls", "pwd", "git"].includes(executable)) return "read_only";
  return "unknown";
}
export function commandPolicy(classification: CommandClassification) {
  if (["read_only", "build", "test", "file_modification"].includes(classification)) return "allow" as const;
  if (["package_install", "database_migration"].includes(classification)) return "require_approval" as const;
  return "deny" as const;
}
