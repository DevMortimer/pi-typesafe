import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  authState, backendPrice, choice, clearAuthState, clearStoredApiKey, createTypeSafe, DECISIONS_BACKENDS, DEFAULT_BACKEND_LIMITS,
  noul, openUsageLedger, resolveBackend, score, TypeSafeIntegrationError,
} from "../src/index.js";
import type { Questions } from "../src/index.js";

// An obviously fake key; nothing here reaches a network.
const naceKey = "nace_fake_key_0123456789abcdef";
const sample = () => ({ state: "synthetic", questions: { yes: noul("Is this synthetic?") } });
const reply = (inputTokens: number) => Response.json({ model: "drex-v2.0", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: inputTokens, output_tokens: 0 }, evaluation_time_ms: 120, request_id: "req_test" });

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKeys = new Map<string, string | undefined>(["TYPESAFE_API_KEY", "NACE_API_KEY"].map(name => [name, process.env[name]]));
const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-nace-"));
let ledgerCount = 0;
const ledgerPath = () => join(workspace, `ledger-${ledgerCount++}.json`);

before(() => {
  process.env.PI_CODING_AGENT_DIR = workspace;
});
beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "ts_fake_key_0123456789abcdef";
  process.env.NACE_API_KEY = naceKey;
  clearStoredApiKey();
  clearAuthState();
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("the nace registry entry names Nace's host, key variable, SDK-shaped model list, and prices, and narrows nothing", () => {
  assert.deepEqual(DECISIONS_BACKENDS.nace, {
    label: "Nace.AI",
    host: "https://console.nace.ai",
    keyEnv: "NACE_API_KEY",
    prices: { "drex-v2.0": 0.06, "drex-v1.5": 0.05, "drex-max": 0.03, "drex-max-v1.1": 0.03, "drex-latest": 0.06, "nacedm-latest": 0.06, "drex-v1.0": 0.03, "drex-v1.1": 0.05 },
  });
  const nace = resolveBackend("nace");
  assert.equal(nace.name, "nace");
  assert.equal(nace.host, "https://console.nace.ai");
  assert.equal(nace.keyEnv, "NACE_API_KEY");
  assert.equal(nace.defaultModel, "drex-v2.0");
  assert.equal(nace.path, undefined);
  assert.equal(nace.modelsPath, undefined);
  assert.equal(nace.modelsVerifyKey, true);
  assert.deepEqual(nace.limits, DEFAULT_BACKEND_LIMITS);
});

test("a nace request goes to /v1/systemone with the NACE_API_KEY bearer and the drex-v2.0 model", async () => {
  let calls = 0;
  const client = createTypeSafe({ backend: "nace", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://console.nace.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${naceKey}`);
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Questions };
    assert.equal(body.model, "drex-v2.0");
    assert.deepEqual(Object.keys(body.questions), ["yes"]);
    return reply(10);
  } });
  const result = await client.evaluate(sample());
  assert.equal(result.answers.yes.noul, 0.9);
  assert.equal(calls, 1);
});

test("a per-request model on nace is sent unchanged, including the moving alias", async () => {
  const sent: string[] = [];
  const client = createTypeSafe({ backend: "nace", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    sent.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return reply(10);
  } });
  await client.evaluate({ ...sample(), model: "drex-v1.5" });
  await client.evaluate({ ...sample(), model: "drex-latest" });
  assert.deepEqual(sent, ["drex-v1.5", "drex-latest"]);
});

test("nace's documented choice and score answers, and a noul confidence, pass validation", async () => {
  const questions = {
    queue: choice("Which team?", { nurse_line: "Nurse", primary_care: "Doctor", front_desk: null }),
    acuity: score("How soon?", ["Within a week", "Within a day", "Within an hour"]),
    urgent: noul("Is this urgent?", { true: "Chest pain is urgent." }),
  };
  const client = createTypeSafe({ backend: "nace", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => Response.json({
    model: "drex-v2.0",
    answers: {
      queue: { type: "choice", choice: "nurse_line", confidence: 0.81, probabilities: { nurse_line: 0.81, primary_care: 0.15, front_desk: 0.04 } },
      acuity: { type: "score", score: 1.6, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, legend: { 0: "Within a week", 1: "Within a day", 2: "Within an hour" } },
      urgent: { type: "noul", noul: 0.92, confidence: 0.88 },
    },
    usage: { input_tokens: 120, output_tokens: 0 },
    evaluation_time_ms: 480,
    request_id: "req_test",
  }) });
  const result = await client.evaluate({ state: "Patient reports shortness of breath.", questions });
  assert.equal(result.answers.queue.choice, "nurse_line");
  assert.equal(result.answers.acuity.score, 1.6);
  assert.equal(result.answers.urgent.noul, 0.92);
});

test("nace accepts every request the schema allows: a 1-option choice, 32 score levels, 64 options, and 32 questions", async () => {
  const levels = Array.from({ length: 32 }, (_, index) => `level ${index}`) as [string, string, ...string[]];
  const options = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`o${index}`, null]));
  const questions = Object.fromEntries(Array.from({ length: 29 }, (_, index) => [`q${index}`, noul(`Question ${index}?`)])) as Questions;
  let sentQuestions = 0;
  const client = createTypeSafe({ backend: "nace", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    sentQuestions = Object.keys((JSON.parse(String(init?.body)) as { questions: Questions }).questions).length;
    return Response.json({
      model: "drex-v2.0",
      answers: {
        only: { type: "choice", choice: "one", confidence: 1, probabilities: { one: 1 } },
        deep: { type: "score", score: 0, confidence: 1, probabilities: Object.fromEntries(levels.map((_, i) => [i, i === 0 ? 1 : 0])), legend: Object.fromEntries(levels.map((level, i) => [i, level])) },
        many: { type: "choice", choice: "o0", confidence: 1, probabilities: Object.fromEntries(Object.keys(options).map((key, i) => [key, i === 0 ? 1 : 0])) },
        ...Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", noul: 0.5 }])),
      },
      usage: { input_tokens: 500, output_tokens: 0 },
    });
  } });
  await client.evaluate({ state: "s", questions: { only: choice("Which?", { one: null }), deep: score("How much?", levels), many: choice("Which of 64?", options), ...questions } });
  assert.equal(sentQuestions, 32);
});

test("nace's model list is read from /v1/models with the SDK's own fields and verifies the key", async () => {
  const urls: string[] = [];
  const client = createTypeSafe({ backend: "nace", fetch: async (url) => {
    urls.push(String(url));
    return Response.json({ models: [{ name: "drex-v2.0", description: "Drex 2.0", release_date: "2026-10-01", alias_for: null }], request_id: "req_test" });
  } });
  assert.deepEqual(await client.listModels(), ["drex-v2.0"]);
  assert.deepEqual(urls, ["https://console.nace.ai/v1/models"]);
  const state = authState({ backend: "nace" });
  assert.equal(state.verified, true);
  assert.ok(state.verifiedAt);
});

test("nace prices drex-v2.0 at $0.06 and drex-max at $0.03 per million input tokens, and leaves an unpriced model at the default", async () => {
  assert.equal(backendPrice(resolveBackend("nace"), "drex-v2.0"), 0.06);
  assert.equal(backendPrice(resolveBackend("nace"), "drex-max"), 0.03);
  assert.equal(backendPrice(resolveBackend("nace"), "drex-max-finance"), undefined);
  const ledger = openUsageLedger({ path: ledgerPath() });
  const client = createTypeSafe({ backend: "nace", ledger, fetch: async () => reply(2_000_000) });
  assert.equal(client.getSpend().usdPerMTok, 0.06);
  await client.evaluate(sample());
  assert.equal(client.getUsage().estimatedUsd, 0.12);
  assert.equal(ledger.today().estimatedUsd, 0.12);
});

test("nace's 422 becomes a safe error that names Nace.AI and NACE_API_KEY, and never quotes the body", async () => {
  const client = createTypeSafe({ backend: "nace", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => Response.json({ detail: "secret detail" }, { status: 422 }) });
  await assert.rejects(client.evaluate(sample()), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "http");
    assert.equal(error.status, 422);
    assert.equal(error.message, "Nace.AI returned HTTP 422. Check the question format and model limits. No automatic retry was made.");
    assert.ok(!error.message.includes("secret detail"));
    return true;
  });
  const unauthorized = createTypeSafe({ backend: "nace", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => Response.json({ detail: "bad key" }, { status: 401 }) });
  await assert.rejects(unauthorized.evaluate(sample()), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.message, "Nace.AI returned HTTP 401. Check NACE_API_KEY. No automatic retry was made.");
    return true;
  });
  assert.equal(authState({ backend: "nace" }).verified, false);
});

test("a missing NACE_API_KEY names the login command and the variable", () => {
  delete process.env.NACE_API_KEY;
  let fetchCalls = 0;
  const fetch = async () => {
    fetchCalls += 1;
    return reply(1);
  };
  assert.throws(() => createTypeSafe({ backend: "nace", fetch }), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "configuration");
    assert.equal(error.message, "No API key. Run /typesafe login nace in Pi, or set NACE_API_KEY in the environment.");
    return true;
  });
  assert.equal(fetchCalls, 0);
});
