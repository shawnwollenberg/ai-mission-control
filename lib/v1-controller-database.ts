import { Pool } from "pg";

let controllerPool: Pool | undefined;

export function getV1ControllerDatabasePool(): Pool {
  const connectionString = process.env.V1_CONTROLLER_DATABASE_URL;
  if (!connectionString) throw new Error("V1 controller database boundary is not configured.");
  controllerPool ??= new Pool({ connectionString, max: 4 });
  return controllerPool;
}
