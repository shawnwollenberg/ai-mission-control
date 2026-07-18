export function createHealthResponse() {
  return {
    status: "ok",
    eventStore: process.env.EVENT_STORE ?? "jsonl",
    generatedAt: new Date().toISOString(),
  };
}
