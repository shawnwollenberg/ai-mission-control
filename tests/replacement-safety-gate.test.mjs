import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLACEMENT_DISPOSABLE_GATE,
  REPLACEMENT_DISPOSABLE_INSTANCE,
  assertDisposableLocalOperatorEnvironment,
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
  disposableEnvironmentFingerprint,
} from "../application/replacement-bootstrap-safety-gate.ts";

const database = {
  mode: "disposable-test",
  instanceIdentity: REPLACEMENT_DISPOSABLE_INSTANCE,
  databaseHost: "127.0.0.1",
  databaseName: "mission_control_replacement_disposable_acceptance",
};
const environment = {
  NODE_ENV: "test",
  MISSION_CONTROL_ENVIRONMENT: "disposable-test",
  MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION: REPLACEMENT_DISPOSABLE_GATE,
  MISSION_CONTROL_INSTANCE_ID: REPLACEMENT_DISPOSABLE_INSTANCE,
  MISSION_AGENT_REPLACEMENT_BOOTSTRAP_RESOURCE_FINGERPRINT: disposableEnvironmentFingerprint(database),
};

test("only a complete fingerprinted loopback disposable environment opens the prerequisite gate", () => {
  const result = assertDisposableReplacementEnvironment({
    environment,
    databaseUrl: "postgresql://tester@127.0.0.1/mission_control_replacement_disposable_acceptance",
    packageInstanceIdentity: REPLACEMENT_DISPOSABLE_INSTANCE,
  });
  assert.equal(result.resourceFingerprint, environment.MISSION_AGENT_REPLACEMENT_BOOTSTRAP_RESOURCE_FINGERPRINT);
  assert.doesNotThrow(() =>
    assertDisposableLocalOperatorEnvironment({
      environment,
      missionControlUrl: "https://127.0.0.1:3443/",
      packageInstanceIdentity: REPLACEMENT_DISPOSABLE_INSTANCE,
    }),
  );
});

test("credential and route code require a database-local disposable guard absent from production migrations", async () => {
  const accepted = await assertDisposableReplacementDatabase({
    async query() {
      return {
        rows: [
          {
            database_name: "mission_control_replacement_disposable_unit",
            instance_identity: REPLACEMENT_DISPOSABLE_INSTANCE,
            resource_fingerprint: "a".repeat(64),
          },
        ],
      };
    },
  });
  assert.equal(accepted, "a".repeat(64));
  await assert.rejects(
    () =>
      assertDisposableReplacementDatabase({
        async query() {
          return { rows: [] };
        },
      }),
    /guard/i,
  );
});

test("production, incomplete configuration, forged request fields, and non-loopback resources fail closed", () => {
  for (const changed of [
    { environment: { ...environment, NODE_ENV: "production" } },
    { environment: { ...environment, MISSION_CONTROL_ENVIRONMENT: undefined } },
    { environment: { ...environment, MISSION_CONTROL_INSTANCE_ID: "production" } },
    {
      environment: {
        ...environment,
        MISSION_AGENT_REPLACEMENT_BOOTSTRAP_RESOURCE_FINGERPRINT: "0".repeat(64),
      },
    },
    { databaseUrl: "postgresql://prod.example.com/mission_control" },
    { databaseUrl: "postgresql://127.0.0.1/mission_control_production" },
    { packageInstanceIdentity: "mission-control-production-661452835066-us-east-1" },
  ]) {
    assert.throws(
      () =>
        assertDisposableReplacementEnvironment({
          environment: changed.environment ?? environment,
          databaseUrl:
            changed.databaseUrl ?? "postgresql://tester@127.0.0.1/mission_control_replacement_disposable_acceptance",
          packageInstanceIdentity: changed.packageInstanceIdentity ?? REPLACEMENT_DISPOSABLE_INSTANCE,
        }),
      /disabled|refuses|fingerprint|disposable/i,
    );
  }
  assert.throws(() =>
    assertDisposableLocalOperatorEnvironment({
      environment,
      missionControlUrl: "https://mission-control.wallyweb.com/",
      packageInstanceIdentity: REPLACEMENT_DISPOSABLE_INSTANCE,
    }),
  );
});

test("every replacement API route is unavailable by default and in production", async () => {
  const prior = {
    NODE_ENV: process.env.NODE_ENV,
    MISSION_CONTROL_ENVIRONMENT: process.env.MISSION_CONTROL_ENVIRONMENT,
    MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION:
      process.env.MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION,
  };
  process.env.NODE_ENV = "production";
  delete process.env.MISSION_CONTROL_ENVIRONMENT;
  delete process.env.MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION;
  try {
    for (const route of ["claim", "intent", "receipt", "decision", "status", "failure"]) {
      const routeModule = await import(`../app/api/mission-agent/replacement-bootstrap/${route}/route.ts`);
      const response = await routeModule.POST(
        new Request(`https://localhost/api/mission-agent/replacement-bootstrap/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environment: "disposable-test", enabled: true }),
        }),
      );
      assert.equal(response.status, 503, route);
      assert.deepEqual(await response.json(), { error: "replacement_bootstrap_disabled" });
    }
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
