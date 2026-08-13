import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../lib/canonical-json.ts";

test("canonical JSON omits undefined object fields and preserves array positions as null", () => {
  const value = { z: undefined, b: [1, undefined, 2], a: "kept" };
  const canonical = canonicalJson(value);
  assert.equal(canonical, '{"a":"kept","b":[1,null,2]}');
  assert.deepEqual(JSON.parse(canonical), { a: "kept", b: [1, null, 2] });
});

test("canonical JSON applies standard toJSON conversion before object canonicalization", () => {
  assert.equal(canonicalJson({ at: new Date("2026-08-10T01:00:00.000Z") }), '{"at":"2026-08-10T01:00:00.000Z"}');
});
