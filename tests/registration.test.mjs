import assert from "node:assert/strict";
import test from "node:test";

const { validateRegistration, personalWorkspaceName, RegistrationValidationError } = await import("../lib/registration.ts");

test("registration normalizes valid member input", () => {
  assert.deepEqual(validateRegistration({ email: " Member@Example.com ", displayName: "  New Member ", password: "a-secure-password" }), {
    email: "member@example.com",
    displayName: "New Member",
    password: "a-secure-password",
  });
});

test("personal workspaces receive a human name", () => {
  assert.equal(personalWorkspaceName("Shawn Wollenberg"), "Shawn's Workspace");
  assert.equal(personalWorkspaceName("James Smith"), "James' Workspace");
});

test("registration rejects invalid identity and weak passwords", () => {
  for (const input of [
    { email: "invalid", displayName: "Member", password: "a-secure-password" },
    { email: "member@example.com", displayName: "M", password: "a-secure-password" },
    { email: "member@example.com", displayName: "Member", password: "short" },
  ]) assert.throws(() => validateRegistration(input), RegistrationValidationError);
});
