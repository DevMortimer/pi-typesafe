import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { clearStoredApiKey, credentialsPath, normalizeApiKey, readStoredApiKey, resolveApiKey, storeApiKey } from "../src/credentials.js";
import { createTypeSafe, TypeSafeIntegrationError } from "../src/index.js";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKey = process.env.TYPESAFE_API_KEY;
let agentDir: string;
const validKey = "ts_test_key_0123456789abcdef";

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-typesafe-credentials-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
beforeEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  clearStoredApiKey();
});
after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  await rm(agentDir, { recursive: true, force: true });
});

test("credentials live under Pi's agent directory", () => {
  assert.equal(credentialsPath(), join(agentDir, "pi-typesafe", "auth.json"));
});

test("store, read, and clear with owner-only permissions", () => {
  assert.equal(resolveApiKey(), undefined);
  const path = storeApiKey(`  ${validKey}\n`);
  assert.equal(path, credentialsPath());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(agentDir, "pi-typesafe")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { apiKey: validKey });
  assert.deepEqual(resolveApiKey(), { key: validKey, source: "stored" });
  assert.equal(clearStoredApiKey(), true);
  assert.equal(clearStoredApiKey(), false);
  assert.equal(readStoredApiKey(), undefined);
});

test("environment variable takes precedence over the stored key", () => {
  storeApiKey(validKey);
  process.env.TYPESAFE_API_KEY = "env_key_0123456789abcdef";
  assert.deepEqual(resolveApiKey(), { key: "env_key_0123456789abcdef", source: "environment" });
});

test("implausible keys are rejected without saving", () => {
  for (const value of ["", "short", "has space in it 0123456789", "tab\tseparated0123456789", "ключ-with-non-ascii-0123456789", "x".repeat(513), 42, null]) {
    assert.throws(() => storeApiKey(value), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "validation" && (String(value).length < 4 || !error.message.includes(String(value))));
  }
  assert.equal(readStoredApiKey(), undefined);
  assert.equal(normalizeApiKey(` ${validKey} `), validKey);
});

test("group- or world-readable credential files are refused", { skip: process.platform === "win32" }, () => {
  storeApiKey(validKey);
  chmodSync(credentialsPath(), 0o644);
  assert.throws(() => resolveApiKey(), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration" && /chmod 600/.test(error.message));
});

test("corrupt or unexpected files are treated as no key", () => {
  mkdirSync(join(agentDir, "pi-typesafe"), { recursive: true, mode: 0o700 });
  for (const content of ["not json", "[]", "{\"apiKey\": 5}", "{}"]) {
    writeFileSync(credentialsPath(), content, { mode: 0o600 });
    assert.equal(readStoredApiKey(), undefined);
  }
});

test("createTypeSafe uses the stored key and listModels verifies it without spending the request budget", async () => {
  storeApiKey(validKey);
  let authorized = false;
  const client = createTypeSafe({ maxRequests: 1, fetch: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/models");
    authorized = Object.values(Object.fromEntries(new Headers(init?.headers))).some(value => value.includes(validKey));
    return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }, { name: 7 }] });
  } });
  assert.deepEqual(await client.listModels(), ["jev-latest"]);
  assert.ok(authorized);
  assert.equal(client.getUsage().requestsStarted, 0);
  assert.throws(() => { clearStoredApiKey(); createTypeSafe(); }, (error: unknown) => error instanceof TypeSafeIntegrationError && /\/typesafe login/.test(error.message));
});

test("invalid keys fail verification with a safe message", async () => {
  const client = createTypeSafe({ apiKey: validKey, fetch: async () => Response.json({ detail: "secret-body" }, { status: 401 }) });
  await assert.rejects(client.listModels(), (error: unknown) => error instanceof TypeSafeIntegrationError && error.status === 401 && !error.message.includes("secret-body"));
});
