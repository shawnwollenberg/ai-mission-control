import { closeDatabasePool } from "../lib/database";
import { assertSupportedNodeVersion } from "../lib/runtime-version";
assertSupportedNodeVersion();
console.log(JSON.stringify({ event: "notification_worker_started", mode: "in_app_projection" }));
void closeDatabasePool();
