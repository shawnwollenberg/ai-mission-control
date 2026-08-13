export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { registerNodeRuntimeTrust } = await import("./instrumentation-node");
  registerNodeRuntimeTrust();
}
