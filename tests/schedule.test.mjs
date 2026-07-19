import assert from "node:assert/strict";
import test from "node:test";
import { nextRun, validateSchedule } from "../domain/schedule.ts";

test("daily schedules preserve local wall time across daylight-saving changes", () => {
  const next = nextRun({ type: "daily", hour: 9 }, new Date("2026-03-08T06:30:00.000Z"), "America/New_York");
  assert.equal(next.toISOString(), "2026-03-08T13:00:00.000Z");
});

test("schedule validation rejects unsafe frequency and invalid time zones", () => {
  assert.throws(() => validateSchedule({ type: "every_n_hours", hours: 0 }, "America/New_York"), /between 1 and 720/);
  assert.throws(() => validateSchedule({ type: "hourly" }, "Mars/Olympus"), /IANA/);
});
