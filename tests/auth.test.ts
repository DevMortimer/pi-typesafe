import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { authState, authStatePath, clearAuthState, describeAuth, recordAuthFailure, recordAuthVerified } from "../src/auth.js";
import { credentialsPath, storeApiKey } from "../src/credentials.js";
import { TypeSafeIntegrationError } from "../src/errors.js";

const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-auth-"));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKey = process.env.TYPESAFE_API_KEY;
before(() => {
  process.env.PI_CODING_AGENT_DIR = workspace;
  delete process.env.TYPESAFE_API_KEY;
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
});

test("no key at all is an error the consumer cannot mistake for a working setup", () => {
  const state = authState();
  assert.equal(state.kind, "missing");
  assert.equal(state.keyName, "no key");
  assert.equal(state.usable, false);
  assert.equal(state.verified, false);
  const report = describeAuth(state);
  assert.equal(report.level, "error");
  assert.ok(report.text.includes("every Jev judgment is skipped"));
});

test("another backend reports its own key and never the TypeSafe login hint", () => {
  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    process.env.TYPESAFE_API_KEY = "env-key-0123456789abcdef";
    assert.equal(authState().backend, "typesafe");
    const missing = authState({ backend: "openrouter" });
    assert.equal(missing.backend, "openrouter");
    assert.equal(missing.kind, "missing");
    assert.equal(missing.usable, false);
    const report = describeAuth(missing);
    assert.equal(report.level, "error");
    assert.ok(report.text.startsWith("OpenRouter key: missing"));
    assert.ok(report.text.includes("OPENROUTER_API_KEY is set"));
    assert.ok(!report.text.includes("/typesafe login"));

    process.env.OPENROUTER_API_KEY = "sk-or-0123456789abcdef";
    const present = authState({ backend: "openrouter" });
    assert.equal(present.kind, "environment");
    assert.equal(present.keyName, "OPENROUTER_API_KEY");
    assert.equal(present.usable, true);
    assert.ok(describeAuth(present).text.startsWith("OpenRouter key: OPENROUTER_API_KEY"));
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedOpenRouter;
  }
});

test("an environment key is usable but unverified until something proves it", () => {
  process.env.TYPESAFE_API_KEY = "env-key-0123456789abcdef";
  try {
    const before = describeAuth(authState());
    assert.equal(before.level, "warning");
    assert.ok(before.text.includes("TYPESAFE_API_KEY"));
    assert.ok(before.text.includes("not verified yet"));
    recordAuthVerified(new Date("2026-01-01T00:00:00.000Z"));
    const state = authState();
    assert.equal(state.usable, true);
    assert.equal(state.verified, true);
    assert.equal(state.verifiedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(describeAuth(state).level, "ok");
    assert.equal(statSync(authStatePath()).mode & 0o777, 0o600);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("a rejected key degrades loudly and a later success clears it", () => {
  storeApiKey("stored-key-0123456789abcdef");
  recordAuthVerified(new Date("2026-01-02T00:00:00.000Z"));
  recordAuthFailure(new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.", 401), new Date("2026-01-02T01:00:00.000Z"));
  const degraded = authState();
  assert.equal(degraded.kind, "stored");
  assert.equal(degraded.usable, false);
  assert.equal(degraded.verified, false);
  assert.deepEqual(degraded.lastFailure, {
    code: "http",
    status: 401,
    message: "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.",
    at: "2026-01-02T01:00:00.000Z",
  });
  const report = describeAuth(degraded);
  assert.equal(report.level, "error");
  assert.ok(report.text.includes("was rejected"));

  // A successful request proves the key again and drops the failure.
  recordAuthVerified(new Date("2026-01-02T02:00:00.000Z"));
  const recovered = authState();
  assert.equal(recovered.usable, true);
  assert.equal(recovered.verified, true);
  assert.equal(recovered.lastFailure, undefined);
});

test("a non-authentication failure degrades the signal without pretending the key is gone", () => {
  storeApiKey("stored-key-0123456789abcdef");
  recordAuthVerified(new Date("2026-01-03T00:00:00.000Z"));
  recordAuthFailure(new TypeSafeIntegrationError("timeout", "TypeSafe request timed out; it was not retried and may still be billed."), new Date("2026-01-03T00:05:00.000Z"));
  const state = authState();
  assert.equal(state.usable, true);
  assert.equal(state.verified, true);
  assert.equal(describeAuth(state).level, "ok");
  assert.ok(describeAuth(state).text.includes("Last failure"));
});

test("a stored key readable by other users is reported as unusable, never as enabled", () => {
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify({ apiKey: "stored-key-0123456789abcdef" }), { mode: 0o600 });
  chmodSync(path, 0o644);
  try {
    const state = authState();
    assert.equal(state.kind, "unusable");
    assert.equal(state.usable, false);
    assert.equal(state.reason !== undefined, true);
    assert.equal(describeAuth(state).level, "error");
  } finally {
    chmodSync(path, 0o600);
  }
});

test("a corrupt auth record is ignored and clearing forgets both facts", () => {
  writeFileSync(authStatePath(), "{ not json");
  assert.equal(authState().verified, false);
  assert.equal(authState().lastFailure, undefined);
  recordAuthVerified(new Date("2026-01-04T00:00:00.000Z"));
  clearAuthState();
  const cleared = authState();
  assert.equal(cleared.verified, false);
  assert.equal(cleared.lastFailure, undefined);
});
