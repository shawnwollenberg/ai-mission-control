import { readFile, writeFile } from "node:fs/promises";

await new Promise((resolve, reject) => {
  process.stdin.on("data", () => undefined);
  process.stdin.on("end", resolve);
  process.stdin.on("error", reject);
});
const source = await readFile("health.mjs", "utf8");
if (!source.includes('service: "sample-app"')) {
  await writeFile("health.mjs", source.replace('{ status: "ok" }', '{ status: "ok", service: "sample-app" }'));
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "controlled-fixture-execution" }));
console.log(JSON.stringify({ type: "item.completed", message: "Added sample-app metadata to the health response." }));
