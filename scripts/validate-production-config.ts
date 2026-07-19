import { closeDatabasePool } from "../lib/database";
import { safeConfigurationReport, validateProductionConfiguration, type ProcessType } from "../lib/production-config";
const processType = (process.argv[2] ?? process.env.PROCESS_TYPE ?? "web") as ProcessType;
validateProductionConfiguration(processType, { requireCurrentSchema: processType !== "migration" })
  .then((result) => {
    console.log(JSON.stringify({ event: "production_configuration_validation", ...safeConfigurationReport(result) }));
    if (!result.ready) process.exitCode = 2;
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        event: "production_configuration_validation_failed",
        message: error instanceof Error ? error.message : String(error),
        secretsPrinted: false,
      }),
    );
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
