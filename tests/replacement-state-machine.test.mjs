import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedOperation,
  intentState,
  replacementForwardOperations,
  replacementOperationDefinitions,
  replacementRollbackOperations,
  stateAfterAcceptedOperation,
} from "../application/replacement-bootstrap-state-machine.ts";

test("the server operation table is total, ordered, and mutation-intent aware", () => {
  assert.equal(expectedOperation({ state: "claimed", lastAcceptedSequence: 0 }), "inspect_host");
  for (const operation of replacementForwardOperations)
    assert.equal(replacementOperationDefinitions[operation].operation, operation);
  for (const operation of replacementRollbackOperations)
    assert.equal(replacementOperationDefinitions[operation].allowedDuringRecovery, true);
  for (const operation of [
    "extract_node_runtime",
    "stop_service",
    "replace_artifact",
    "replace_plist",
    "start_service",
  ]) {
    assert.equal(replacementOperationDefinitions[operation].mutating, true);
    assert.equal(expectedOperation({ state: intentState(operation), lastAcceptedSequence: 0 }), operation);
  }
});

test("skips, forward-after-rollback, early completion, and rollback-before-failure fail closed", () => {
  assert.throws(() =>
    stateAfterAcceptedOperation({ state: "claimed", operation: "inspect_agent", smokeAccepted: false }),
  );
  assert.throws(() =>
    stateAfterAcceptedOperation({
      state: "ready:report_evidence",
      operation: "report_evidence",
      smokeAccepted: false,
    }),
  );
  assert.throws(() =>
    stateAfterAcceptedOperation({
      state: "rollback:restore_artifact",
      operation: "replace_artifact",
      smokeAccepted: false,
    }),
  );
  assert.throws(() =>
    stateAfterAcceptedOperation({
      state: "ready:inspect_agent",
      operation: "restore_artifact",
      smokeAccepted: false,
    }),
  );
});

test("forward and rollback chains terminate only at governed terminal states", () => {
  let state = "claimed";
  for (const operation of replacementForwardOperations.slice(0, -1))
    state = stateAfterAcceptedOperation({ state, operation, smokeAccepted: false });
  assert.equal(state, "awaiting-authoritative-smoke");
  state = "ready:report_evidence";
  assert.equal(stateAfterAcceptedOperation({ state, operation: "report_evidence", smokeAccepted: true }), "completed");
  state = "rollback-required";
  for (const operation of replacementRollbackOperations)
    state = stateAfterAcceptedOperation({ state, operation, smokeAccepted: false });
  assert.equal(state, "rolled-back");
});
