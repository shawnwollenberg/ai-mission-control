import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const sourcePath = resolve("public/mission-agent-0.7.2.mjs");
const targetPath = resolve("public/mission-agent-0.7.3.mjs");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Unable to read a full Git SHA for 0.7.3");

let source = await readFile(sourcePath, "utf8");
if (!source.includes('const VERSION = "0.7.2";')) throw new Error("0.7.2 source marker missing");

const grokHelpers = `
function parseGrokJson(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Grok did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}
function grokStructuredResult(payload) {
  if (payload?.structured_output && typeof payload.structured_output === "object") return payload.structured_output;
  if (payload?.structuredOutput && typeof payload.structuredOutput === "object") return payload.structuredOutput;
  if (typeof payload?.text === "string") {
    try {
      return JSON.parse(payload.text);
    } catch {
      return payload;
    }
  }
  return payload;
}
const GROK_INTELLIGENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["recommendations", "observations"],
  properties: {
    recommendations: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "reasoning",
          "evidence",
          "estimatedImpact",
          "estimatedRisk",
          "estimatedEffort",
          "suggestedValidation",
          "acceptanceCriteria",
        ],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          reasoning: { type: "string" },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "description"],
              properties: {
                path: { type: "string" },
                line: { type: "integer" },
                description: { type: "string" },
              },
            },
          },
          estimatedImpact: { type: "string", enum: ["low", "medium", "high", "critical"] },
          estimatedRisk: { type: "string", enum: ["low", "medium", "high"] },
          estimatedEffort: { type: "string" },
          suggestedValidation: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    observations: {
      type: "array",
      minItems: 7,
      maxItems: 70,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "status", "severity", "summary", "evidence"],
        properties: {
          dimension: {
            type: "string",
            enum: ["architecture", "tests", "security", "technical_debt", "documentation", "dependencies", "ci"],
          },
          status: { type: "string", enum: ["strength", "risk", "unknown"] },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          summary: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "description"],
              properties: {
                path: { type: "string" },
                line: { type: "integer" },
                description: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
async function runGrok(config, assignment, prompt, cwd, extraArgs = [], heartbeatStage = "inspecting_repository") {
  const args = [
    "-p",
    prompt,
    "--sandbox",
    "read-only",
    "--tools",
    "read_file,grep,list_dir",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "--no-auto-update",
    "--disallowed-tools",
    "search_replace,run_terminal_cmd,web_search,web_fetch,Agent",
    "--output-format",
    "json",
    "--max-turns",
    "40",
    ...extraArgs,
  ];
  const child = spawn("grok", args, {
    cwd,
    env: Object.fromEntries(
      ["PATH", "HOME", "GROK_HOME", "XAI_API_KEY", "TMPDIR", "LANG", "LC_ALL", "TERM"].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout = (stdout + String(chunk)).slice(-512_000)));
  child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-512_000)));
  const renew = setInterval(() => {
    void Promise.all([
      assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed"),
      executionHeartbeat(config, assignment, heartbeatStage, "Grok is analyzing the repository", 50),
    ]).catch(() => child.kill("SIGTERM"));
  }, 25_000);
  const cancel = setInterval(async () => {
    const result = await assignmentAction(
      config,
      assignment,
      "cancellation",
      "AgentAssignmentCancellationChecked",
    ).catch(() => undefined);
    if (result?.cancellationRequested) child.kill("SIGTERM");
  }, 10_000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("Grok could not be started. Install grok, run grok login, then mission-agent doctor.");
    throw error;
  } finally {
    clearInterval(renew);
    clearInterval(cancel);
  }
  return { exitCode, stdout, stderr };
}
`;

source = source
  .replace('const VERSION = "0.7.2";', 'const VERSION = "0.7.3";')
  .replace(/const BUILD_SOURCE_COMMIT = "[a-f0-9]{40}";/, `const BUILD_SOURCE_COMMIT = "${sourceCommit}";`)
  .replace(
    `  if (config.adapter !== "codex")
    throw new Error(\`The \${config.adapter} adapter can connect but cannot execute local tasks yet.\`);`,
    `  if (config.adapter !== "codex" && config.adapter !== "grok")
    throw new Error(\`The \${config.adapter} adapter can connect but cannot execute local tasks yet.\`);`,
  )
  .replace(
    `  if (config.adapter !== "codex") throw new Error("Repository changes currently require the Codex adapter.");`,
    `  if (config.adapter !== "codex")
    throw new Error("Repository changes currently require the Codex adapter. Grok can analyze only.");`,
  )
  .replace(
    `  checks.push([spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0, "Codex executable"]);`,
    `  checks.push([
    config?.adapter === "grok"
      ? spawnSync("grok", ["--version"], { stdio: "ignore" }).status === 0
      : spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0,
    config?.adapter === "grok" ? "Grok executable" : "Codex executable",
  ]);`,
  );

if (!source.includes("async function executeAnalysis(config, assignment) {"))
  throw new Error("executeAnalysis marker missing");
source = source.replace(
  "async function executeAnalysis(config, assignment) {",
  `${grokHelpers}async function executeAnalysis(config, assignment) {`,
);

const analysisSpawn = `  const child = spawn("codex", ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", outputPath, prompt], {`;
if (!source.includes(analysisSpawn)) throw new Error("Codex analysis spawn marker missing");
source = source.replace(
  analysisSpawn,
  `  if (config.adapter === "grok") {
    const grokResult = await runGrok(config, assignment, prompt, resolved);
    if (grokResult.exitCode !== 0)
      throw new Error(\`Grok analysis failed\${grokResult.stderr ? ": " + grokResult.stderr.slice(-300) : "."}\`);
    const markdown = String(parseGrokJson(grokResult.stdout).text ?? "").trim();
    if (!markdown) throw new Error("Grok analysis produced no report.");
    await writeFile(outputPath, markdown);
  } else {
  const child = spawn("codex", ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", outputPath, prompt], {`,
);

const afterSpawnClose = `  if (exitCode !== 0) throw new Error(\`Codex analysis failed\${stderr ? ": " + stderr.slice(-300) : "."}\`);
  await progress(config, assignment, "preparing_findings", "Preparing findings", 75);`;
if (!source.includes(afterSpawnClose)) throw new Error("Codex analysis close marker missing");
source = source.replace(
  afterSpawnClose,
  `  if (exitCode !== 0) throw new Error(\`Codex analysis failed\${stderr ? ": " + stderr.slice(-300) : "."}\`);
  }
  await progress(config, assignment, "preparing_findings", "Preparing findings", 75);`,
);

source = source.replace(
  `    description: "Read-only analysis produced by the local Codex adapter",`,
  `    description: config.adapter === "grok"
      ? "Read-only analysis produced by the local Grok adapter"
      : "Read-only analysis produced by the local Codex adapter",`,
);

const recommendationBlock = `  const recommendationResult = await runCodex(
    config,
    assignment,
    ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", recommendationsPath, recommendationPrompt],
    resolved,
  );
  if (recommendationResult.exitCode !== 0)
    throw new Error(
      \`Codex recommendation extraction failed\${recommendationResult.stderr ? ": " + recommendationResult.stderr.slice(-300) : "."}\`,
    );
  const recommendationBody = await readFile(recommendationsPath);
  let intelligenceValue;
  try {
    intelligenceValue = JSON.parse(recommendationBody.toString("utf8"));
  } catch {
    throw new Error("Codex returned invalid structured repository intelligence.");
  }`;
if (!source.includes("const recommendationResult = await runCodex("))
  throw new Error("recommendation extraction marker missing");
source = source.replace(
  recommendationBlock,
  `  let intelligenceValue;
  if (config.adapter === "grok") {
    const grokResult = await runGrok(
      config,
      assignment,
      recommendationPrompt,
      resolved,
      ["--json-schema", JSON.stringify(GROK_INTELLIGENCE_SCHEMA)],
      "structuring_recommendations",
    );
    if (grokResult.exitCode !== 0)
      throw new Error(
        \`Grok recommendation extraction failed\${grokResult.stderr ? ": " + grokResult.stderr.slice(-300) : "."}\`,
      );
    try {
      intelligenceValue = grokStructuredResult(parseGrokJson(grokResult.stdout));
    } catch {
      throw new Error("Grok returned invalid structured repository intelligence.");
    }
    await writeFile(recommendationsPath, JSON.stringify(intelligenceValue));
  } else {
  const recommendationResult = await runCodex(
    config,
    assignment,
    ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", recommendationsPath, recommendationPrompt],
    resolved,
  );
  if (recommendationResult.exitCode !== 0)
    throw new Error(
      \`Codex recommendation extraction failed\${recommendationResult.stderr ? ": " + recommendationResult.stderr.slice(-300) : "."}\`,
    );
  const recommendationBody = await readFile(recommendationsPath);
  try {
    intelligenceValue = JSON.parse(recommendationBody.toString("utf8"));
  } catch {
    throw new Error("Codex returned invalid structured repository intelligence.");
  }
  }`,
);

source = source.replaceAll(
  `throw new Error("Codex returned an unsupported recommendation set.");`,
  `throw new Error(\`\${config.adapter === "grok" ? "Grok" : "Codex"} returned an unsupported recommendation set.\`);`,
);
source = source.replaceAll(
  `throw new Error("Codex returned an unsupported repository health observation set.");`,
  `throw new Error(\`\${config.adapter === "grok" ? "Grok" : "Codex"} returned an unsupported repository health observation set.\`);`,
);

if (source.includes('const VERSION = "0.7.2";')) throw new Error("0.7.2 version leaked into 0.7.3");
if (!source.includes("async function runGrok(")) throw new Error("runGrok was not inserted");
if (!source.includes('config.adapter === "grok"')) throw new Error("Grok adapter branch missing");

await writeFile(targetPath, source);
const bytes = Buffer.from(source);
const checksum = createHash("sha256").update(bytes).digest("hex");
process.stdout.write(
  JSON.stringify(
    {
      version: "0.7.3",
      sourceCommit,
      artifactByteLength: bytes.byteLength,
      sha256: checksum,
      path: targetPath,
    },
    null,
    2,
  ) + "\n",
);
