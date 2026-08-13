import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapAcceptanceRun, type AcceptanceBootstrapRequest } from "../lib/acceptance-bootstrap-authority";

const requestPath = process.argv[2];
if (!requestPath) throw new Error("Usage: bootstrap-consensus-real-acceptance <request.json>");
const request = JSON.parse(readFileSync(resolve(requestPath), "utf8")) as AcceptanceBootstrapRequest;
const handoff = bootstrapAcceptanceRun(request);
process.stdout.write(`${JSON.stringify(handoff)}\n`);
