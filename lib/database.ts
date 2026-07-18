import { Pool, type PoolClient, type PoolConfig } from "pg";

declare global {
  var missionControlPool: Pool | undefined;
}

function databaseConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL operations");
  return {
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: process.env.DATABASE_APPLICATION_NAME ?? "mission-control-web",
  };
}

export function getDatabasePool(): Pool {
  if (!globalThis.missionControlPool) globalThis.missionControlPool = new Pool(databaseConfig());
  return globalThis.missionControlPool;
}

export async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabasePool(): Promise<void> {
  if (!globalThis.missionControlPool) return;
  await globalThis.missionControlPool.end();
  globalThis.missionControlPool = undefined;
}
