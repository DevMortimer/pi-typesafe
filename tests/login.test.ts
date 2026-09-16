import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TypeSafeIntegrationError } from "../src/errors.js";
import { ensureApiKey, loginWithPrompt } from "../src/login.js";

let temporary: string;
const savedKey = process.env.TYPESAFE_API_KEY;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
let customResult: string | undefined;
let modelListCalls = 0;
const storedPath = () => join(temporary, "pi-typesafe", "auth.json");
const ctx = (hasUI = true) => ({ hasUI, ui: { custom: async () => customResult, input: async () => { throw new Error("plain input must not be used"); } } }) as unknown as ExtensionCommandContext;

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-typesafe-login-"));
  process.env.PI_CODING_AGENT_DIR = temporary;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/v1/models")) {
      modelListCalls++;
      return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }, { name: "jev-preview", description: "", release_date: "2026-01-01" }] });
    }
    throw new Error("unexpected request");
  };
});
beforeEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  modelListCalls = 0;
  customResult = undefined;
  await rm(storedPath(), { force: true });
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await rm(temporary, { recursive: true, force: true });
});

test("loginWithPrompt cancels cleanly, rejects bad keys, and stores a verified key with owner-only permissions", async () => {
  assert.equal(await loginWithPrompt(ctx()), undefined);
  assert.equal(existsSync(storedPath()), false);

  customResult = "nope";
  await assert.rejects(loginWithPrompt(ctx()), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "validation" && !error.message.includes("nope"));
  assert.equal(modelListCalls, 0);

  customResult = "ts_live_key_0123456789abcdef";
  const result = await loginWithPrompt(ctx());
  assert.deepEqual(result, { path: storedPath(), models: 2 });
  assert.equal(modelListCalls, 1);
  assert.equal(statSync(storedPath()).mode & 0o777, 0o600);
});

test("loginWithPrompt refuses when the environment key would shadow the store, or without a UI", async () => {
  process.env.TYPESAFE_API_KEY = "env-key-0123456789";
  await assert.rejects(loginWithPrompt(ctx()), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration" && /TYPESAFE_API_KEY/.test(error.message));
  delete process.env.TYPESAFE_API_KEY;
  await assert.rejects(loginWithPrompt(ctx(false)), (error: unknown) => error instanceof TypeSafeIntegrationError && /interactive/.test(error.message));
  assert.equal(existsSync(storedPath()), false);
});

test("ensureApiKey reports an existing key without prompting, otherwise logs in", async () => {
  process.env.TYPESAFE_API_KEY = "env-key-0123456789";
  customResult = "must-not-be-used-0123456789";
  assert.deepEqual(await ensureApiKey(ctx()), { source: "environment" });
  assert.equal(existsSync(storedPath()), false);

  delete process.env.TYPESAFE_API_KEY;
  customResult = undefined;
  assert.equal(await ensureApiKey(ctx()), undefined, "cancelled prompt");

  customResult = "ts_live_key_0123456789abcdef";
  const first = await ensureApiKey(ctx());
  assert.deepEqual(first, { source: "stored", login: { path: storedPath(), models: 2 } });
  customResult = "another-key-that-must-not-replace-it";
  assert.deepEqual(await ensureApiKey(ctx()), { source: "stored" }, "second call reuses the stored key");
  assert.equal(modelListCalls, 1);
});
