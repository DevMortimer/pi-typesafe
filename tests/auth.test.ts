import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AUTH_REJECTION_TTL_MS, authState, authStatePath, clearAuthState, describeAuth, isKeyRejection, recordAuthFailure, recordAuthVerified } from "../src/auth.js";
import { clearStoredApiKey, credentialsPath, piTypesafeDir, storeApiKey } from "../src/credentials.js";
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
  assert.ok(report.text.includes("every Jev judgment will fail"));
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
    assert.ok(report.text.includes("OPENROUTER_API_KEY"));
    assert.ok(report.text.includes("/typesafe login openrouter"));

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
  const rejectedAt = new Date(Date.now() - 60_000).toISOString();
  recordAuthFailure(new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.", 401), new Date(rejectedAt));
  const degraded = authState();
  assert.equal(degraded.kind, "stored");
  assert.equal(degraded.usable, false);
  assert.equal(degraded.verified, false);
  assert.deepEqual(degraded.lastFailure, {
    code: "http",
    status: 401,
    message: "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.",
    at: rejectedAt,
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

test("the rejection predicate refuses only a 401", () => {
  assert.equal(isKeyRejection(401), true);
  for (const status of [undefined, 400, 402, 403, 404, 429, 500]) assert.equal(isKeyRejection(status), false, `${status}`);
});

// The old tests recorded a 401 and never looked at the clock, and no test pinned a 403 to the key's fate; this table is
// the whole cross-product, so one wrong cell fails.
test("only a fresh 401 vetoes the key: the whole key × failure table", () => {
  mkdirSync(piTypesafeDir(), { recursive: true, mode: 0o700 });
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const stale = new Date(Date.now() - AUTH_REJECTION_TTL_MS - 60_000).toISOString();
  type Row = { name: string; status?: number; at?: string; level: "ok" | "warning" | "error"; usable: boolean; verified: boolean };
  // `verified` holds with `verifiedAt` set in every cell, so the only thing that lowers it is a fresh 401.
  const failures: readonly Row[] = [
    { name: "no failure", level: "ok", usable: true, verified: true },
    { name: "401 inside the window", status: 401, at: fresh, level: "error", usable: false, verified: false },
    { name: "401 past the window", status: 401, at: stale, level: "warning", usable: true, verified: true },
    { name: "403 inside the window", status: 403, at: fresh, level: "ok", usable: true, verified: true },
    { name: "403 past the window", status: 403, at: stale, level: "ok", usable: true, verified: true },
    { name: "402 inside the window", status: 402, at: fresh, level: "ok", usable: true, verified: true },
    { name: "429 inside the window", status: 429, at: fresh, level: "ok", usable: true, verified: true },
  ];
  const keys = [
    { name: "no key", arrange: () => { delete process.env.TYPESAFE_API_KEY; clearStoredApiKey(); } },
    { name: "environment key", arrange: () => { clearStoredApiKey(); process.env.TYPESAFE_API_KEY = "env-key-0123456789abcdef"; } },
    { name: "stored key", arrange: () => { delete process.env.TYPESAFE_API_KEY; storeApiKey("stored-key-0123456789abcdef"); } },
  ];
  try {
    for (const key of keys) for (const row of failures) {
      key.arrange();
      const lastFailure = row.status === undefined ? undefined : { code: "http", status: row.status, message: `TypeSafe returned HTTP ${row.status}.`, at: row.at };
      writeFileSync(authStatePath(), JSON.stringify({ version: 1, verifiedAt: "2026-01-01T00:00:00.000Z", ...(lastFailure === undefined ? {} : { lastFailure }) }));
      const state = authState();
      const cell = `${key.name} × ${row.name}`;
      assert.equal(state.usable, key.name !== "no key" && row.usable, `${cell}: usable`);
      assert.equal(state.verified, row.verified, `${cell}: verified`);
      assert.equal(describeAuth(state).level, key.name === "no key" ? "error" : row.level, `${cell}: level`);
    }
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    clearStoredApiKey();
  }
  // An expired rejection is reported, not hidden: it keeps its time and names the way back.
  process.env.TYPESAFE_API_KEY = "env-key-0123456789abcdef";
  writeFileSync(authStatePath(), JSON.stringify({ version: 1, lastFailure: { code: "http", status: 401, message: "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.", at: stale } }));
  try {
    const report = describeAuth(authState());
    assert.equal(report.level, "warning");
    assert.ok(report.text.includes(`was rejected at ${stale}`), report.text);
    assert.ok(report.text.includes("the next request proves the key"), report.text);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("a rejection ends at the next success, and a 403 never becomes one", () => {
  storeApiKey("stored-key-0123456789abcdef");
  recordAuthFailure(new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.", 401), new Date(Date.now() - 60_000));
  const degraded = authState();
  assert.deepEqual([degraded.usable, degraded.verified, describeAuth(degraded).level], [false, false, "error"]);

  recordAuthVerified(new Date());
  const cleared = authState();
  assert.deepEqual([cleared.usable, cleared.verified, cleared.lastFailure], [true, true, undefined]);

  recordAuthFailure(new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 403. Check your account access and model permissions. No automatic retry was made.", 403), new Date());
  const refused = authState();
  assert.deepEqual([refused.usable, refused.verified, describeAuth(refused).level], [true, true, "ok"]);
  assert.equal(refused.lastFailure?.status, 403);

  recordAuthVerified(new Date());
  assert.deepEqual([authState().usable, authState().lastFailure], [true, undefined]);
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
