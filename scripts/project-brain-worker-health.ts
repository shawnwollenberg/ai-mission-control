import { closeDatabasePool, getDatabasePool } from "../lib/database";
import {
  diagnoseProjectBrainDependencies,
  diagnoseProjectBrainRuntime,
  safeProjectBrainDependencyReport,
  safeProjectBrainDiagnosticReport,
} from "../integrations/project-brain/diagnostics";

async function main() {
  await getDatabasePool().query("SELECT 1");
  const report = await diagnoseProjectBrainRuntime();
  const dependencies = await diagnoseProjectBrainDependencies();
  console.log(JSON.stringify(safeProjectBrainDiagnosticReport(report)));
  console.log(JSON.stringify(safeProjectBrainDependencyReport(dependencies)));
  if (!report.ready || !dependencies.ready) process.exitCode = 2;
}

main()
  .catch(() => {
    console.error(
      JSON.stringify({
        event: "project_brain_worker_health_failed",
        failure: "database_or_runtime_unavailable",
        secretsPrinted: false,
      }),
    );
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
