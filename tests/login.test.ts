import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { authStatePath, clearAuthState, recordAuthVerified } from "../src/auth.js";
import { resolveBackend } from "../src/backends.js";
import { TypeSafeIntegrationError } from "../src/errors.js";
import { ensureApiKey, loginWithPrompt, transitionLogin } from "../src/login.js";
import type { LoginEvent, LoginState } from "../src/login.js";
import { openUsageLedger, usagePath } from "../src/usage.js";

let temporary: string;
const savedKey = process.env.TYPESAFE_API_KEY;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
let customResult: string | undefined;
let modelListCalls = 0;
let decisionCalls = 0;
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
    if (String(input).includes("openrouter.ai/api/alpha/decisions")) {
      decisionCalls++;
      return Response.json({ model: "typesafe/jev-1.13", answers: { key: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 10, output_tokens: 0 } });
    }
    throw new Error("unexpected request");
  };
});
beforeEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  modelListCalls = 0;
  decisionCalls = 0;
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

test("another backend keeps its own key: its environment variable wins, otherwise its own login stores it", async () => {
  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    // A stored TypeSafe key does not satisfy OpenRouter: the store is keyed by backend.
    customResult = "ts_live_key_0123456789abcdef";
    assert.deepEqual(await ensureApiKey(ctx()), { source: "stored", login: { path: storedPath(), models: 2 } });

    // OpenRouter's model list is public, so the login proves the key with one request and stores it under its own name.
    customResult = "sk-or-0123456789abcdef";
    const login = await ensureApiKey(ctx(), { backend: "openrouter" });
    assert.equal(login?.source, "stored");
    assert.equal(decisionCalls, 1, "one request proves the key");
    assert.equal(modelListCalls, 1, "no model-list call for a public list");

    process.env.OPENROUTER_API_KEY = "sk-or-0123456789abcdef";
    assert.deepEqual(await ensureApiKey(ctx(), { backend: "openrouter" }), { source: "environment" });
    assert.equal(modelListCalls, 1);
  } finally {
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedOpenRouter;
  }
});

test("judge-probe login isolates usage.json and restores auth-state.json when a candidate key is rejected", async () => {
  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  const savedMaxDay = process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY;
  const savedFetch = globalThis.fetch;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY;
  clearAuthState();
  await rm(usagePath(), { force: true });
  try {
    // 1. Rejected candidate key with no prior auth-state.json leaves auth.json, auth-state.json, and usage.json absent.
    globalThis.fetch = async () => Response.json({ error: { message: "bad key" } }, { status: 401 });
    customResult = "sk-or-bad-key-0123456789";
    await assert.rejects(loginWithPrompt(ctx(), { backend: "openrouter" }), /HTTP 401/);
    assert.equal(existsSync(storedPath()), false, "rejected key must not be saved");
    assert.equal(existsSync(authStatePath()), false, "rejected candidate probe must not create auth-state.json");
    assert.equal(existsSync(usagePath()), false, "judge probe must not write usage.json");

    // 2. Rejected candidate key with an existing verified auth-state.json restores it byte-for-byte.
    recordAuthVerified(new Date("2026-06-01T00:00:00.000Z"));
    const priorAuthState = readFileSync(authStatePath(), "utf8");
    await assert.rejects(loginWithPrompt(ctx(), { backend: "openrouter" }), /HTTP 401/);
    assert.equal(readFileSync(authStatePath(), "utf8"), priorAuthState, "rejected candidate probe must restore prior auth-state.json");
    assert.equal(existsSync(usagePath()), false, "judge probe must still leave usage.json untouched");

    // 3. Active daily cap must not block login verification, and successful probe must not write usage.json.
    const ledger = openUsageLedger();
    ledger.recordStart();
    ledger.recordSuccess(50, 0);
    const priorUsage = readFileSync(usagePath(), "utf8");
    process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY = "1";
    globalThis.fetch = async () => Response.json({ model: "typesafe/jev-1.13", answers: { key: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 10, output_tokens: 0 } });
    customResult = "sk-or-good-key-0123456789";
    const result = await loginWithPrompt(ctx(), { backend: "openrouter" });
    assert.deepEqual(result, { path: storedPath() });
    assert.equal(readFileSync(usagePath(), "utf8"), priorUsage, "successful judge probe must not modify usage.json");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedOpenRouter;
    if (savedMaxDay === undefined) delete process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY; else process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY = savedMaxDay;
    clearAuthState();
    await rm(usagePath(), { force: true });
  }
});

test("transitionLogin table proves every valid login stage transition and rejects out-of-order moves", () => {
  const tsConfig = resolveBackend("typesafe");
  const orConfig = resolveBackend("openrouter");

  // 1. models_list happy path (typesafe).
  let s: LoginState = { stage: "precheck", spec: "typesafe", config: tsConfig };
  s = transitionLogin(s, { type: "precheck_passed" });
  assert.equal(s.stage, "prompting");
  s = transitionLogin(s, { type: "prompt_submitted", entered: "ts_key_0123456789" });
  assert.equal(s.stage, "validating");
  s = transitionLogin(s, { type: "key_validated", key: "ts_key_0123456789" });
  assert.equal(s.stage, "probing");
  assert.equal(s.mode, "models_list");
  s = transitionLogin(s, { type: "probe_succeeded", models: 3 });
  assert.equal(s.stage, "storing");
  s = transitionLogin(s, { type: "stored", path: "/fake/auth.json" });
  assert.deepEqual(s, { stage: "verified", result: { path: "/fake/auth.json", models: 3 } });

  // 2. judge_probe happy path (openrouter) keeps LoginResult free of an undefined models key.
  let o: LoginState = { stage: "precheck", spec: "openrouter", config: orConfig };
  o = transitionLogin(o, { type: "precheck_passed" });
  o = transitionLogin(o, { type: "prompt_submitted", entered: "sk-or-0123456789ab" });
  o = transitionLogin(o, { type: "key_validated", key: "sk-or-0123456789ab" });
  assert.equal(o.stage, "probing");
  assert.equal(o.mode, "judge_probe");
  o = transitionLogin(o, { type: "probe_succeeded" });
  o = transitionLogin(o, { type: "stored", path: "/fake/auth.json" });
  assert.deepEqual(o, { stage: "verified", result: { path: "/fake/auth.json" } });
  assert.equal(Object.hasOwn(o.result, "models"), false);

  // 3. Cancellation and failure from every non-terminal stage.
  const precheck: LoginState = { stage: "precheck", spec: "typesafe", config: tsConfig };
  const prompting = transitionLogin(precheck, { type: "precheck_passed" });
  const cancelled = transitionLogin(prompting, { type: "prompt_cancelled" });
  assert.deepEqual(cancelled, { stage: "cancelled" });
  const validating = transitionLogin(prompting, { type: "prompt_submitted", entered: "ts_key_0123456789" });
  const probing = transitionLogin(validating, { type: "key_validated", key: "ts_key_0123456789" });
  const storing = transitionLogin(probing, { type: "probe_succeeded", models: 1 });
  const err = new Error("boom");
  for (const stage of [precheck, prompting, validating, probing, storing]) {
    assert.deepEqual(transitionLogin(stage, { type: "failed", error: err }), { stage: "failed", error: err });
  }

  // 4. Out-of-order and post-terminal transitions throw.
  const invalidMoves: Array<[LoginState, LoginEvent]> = [
    [precheck, { type: "prompt_cancelled" }],
    [precheck, { type: "stored", path: "/fake/auth.json" }],
    [prompting, { type: "precheck_passed" }],
    [prompting, { type: "key_validated", key: "k" }],
    [validating, { type: "probe_succeeded" }],
    [probing, { type: "stored", path: "/fake/auth.json" }],
    [storing, { type: "probe_succeeded" }],
    [cancelled, { type: "precheck_passed" }],
    [cancelled, { type: "failed", error: err }],
    [s, { type: "stored", path: "/fake/auth.json" }],
    [s, { type: "failed", error: err }],
    [{ stage: "failed", error: err }, { type: "precheck_passed" }],
    [{ stage: "failed", error: err }, { type: "failed", error: err }],
  ];
  for (const [state, event] of invalidMoves) {
    assert.throws(() => transitionLogin(state, event), /Invalid login transition/);
  }
});
