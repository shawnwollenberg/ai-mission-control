import { assertRuntimeStartupSafety } from "@/lib/runtime-trust";

export function registerNodeRuntimeTrust() {
  const trust = assertRuntimeStartupSafety();
  console.log(
    JSON.stringify({
      event: "mission_control_runtime_started",
      label: trust.disposable ? "DISPOSABLE ACCEPTANCE — NON-PRODUCTION" : trust.runtimeMode,
      runtimeTrust: trust,
      productionContacted: false,
      secretsPrinted: false,
    }),
  );
}
