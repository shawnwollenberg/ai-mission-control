#!/usr/bin/env node
import { spawn } from "node:child_process";
import { governedPostgresDataDirectory } from "../lib/acceptance-postgres-data-directory.ts";

const dataDirectory = process.env.CONSENSUS_ACCEPTANCE_POSTGRES_DATA;
const port = Number(process.env.CONSENSUS_ACCEPTANCE_POSTGRES_PORT);
const acceptanceRoot = process.env.CONSENSUS_ACCEPTANCE_ROOT;
if (process.env.APP_ENV !== "disposable_acceptance" || !dataDirectory || !acceptanceRoot || !Number.isSafeInteger(port))
  throw new Error("Disposable PostgreSQL requires exact acceptance-only path and port bindings");

const governedDataDirectory = governedPostgresDataDirectory(dataDirectory, acceptanceRoot);
const run = (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${executable} failed: exit=${code} signal=${signal}`)),
    );
  });
await run("/usr/local/opt/postgresql@17/bin/initdb", [
  "--auth=trust",
  "--no-locale",
  "--username=mission_control",
  "-D",
  governedDataDirectory,
]);
const postgres = spawn(
  "/usr/local/opt/postgresql@17/bin/postgres",
  ["-D", governedDataDirectory, "-h", "127.0.0.1", "-p", String(port)],
  { stdio: "inherit", env: process.env },
);
const stop = (signal) => {
  if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill(signal);
};
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
const outcome = await new Promise((resolve, reject) => {
  postgres.once("error", reject);
  postgres.once("close", (code, signal) => resolve({ code, signal }));
});
if (outcome.code !== 0 && outcome.signal !== "SIGTERM" && outcome.signal !== "SIGINT")
  throw new Error(`Disposable PostgreSQL failed: exit=${outcome.code} signal=${outcome.signal}`);
