import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  authState, backendPrice, choice, chunkEvaluationRequest, clearAuthState, clearStoredApiKey, createTypeSafe, DECISIONS_BACKENDS, DEFAULT_BACKEND_LIMITS,
  noul, openUsageLedger, resolveBackend, score, TypeSafeIntegrationError,
} from "../src/index.js";
import type { Questions } from "../src/index.js";

// An obviously fake key; nothing here reaches a network.
const sqKey = "sq_fake_key_0123456789abcdef";
const sample = () => ({ state: "synthetic", questions: { yes: noul("Is this synthetic?") } });
const reply = (inputTokens: number) => Response.json({ model: "subq-snap-preview", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: inputTokens, output_tokens: 0 } });
const manyQuestions = (count: number): Questions => Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index}`, noul(`Question ${index}?`)]));
const answerAll = (init?: RequestInit) => {
  const { questions } = JSON.parse(String(init?.body)) as { questions: Questions };
  const answers = Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", noul: 0.5 }]));
  return Response.json({ model: "subq-snap-preview", answers, usage: { input_tokens: 10, output_tokens: 0 } });
};
const rejects = (code: string) => (error: unknown) => {
  assert.ok(error instanceof TypeSafeIntegrationError);
  assert.equal(error.code, code);
  return true;
};

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKeys = new Map<string, string | undefined>(["TYPESAFE_API_KEY", "SUBQ_API_KEY"].map(name => [name, process.env[name]]));
const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-subq-"));
let ledgerCount = 0;
const ledgerPath = () => join(workspace, `ledger-${ledgerCount++}.json`);

before(() => {
  process.env.PI_CODING_AGENT_DIR = workspace;
});
beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "ts_fake_key_0123456789abcdef";
  process.env.SUBQ_API_KEY = sqKey;
  clearStoredApiKey();
  clearAuthState();
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("the subq registry entry names SubQ's host, key variable, public model list, limits, and price", () => {
  assert.deepEqual(DECISIONS_BACKENDS.subq, {
    label: "SubQ",
    host: "https://api.subq.ai",
    keyEnv: "SUBQ_API_KEY",
    modelsField: "data",
    modelsIdField: "id",
    modelsVerifyKey: false,
    limits: { maxQuestions: 16, minChoiceOptions: 2, maxScoreLevels: 10 },
    prices: { "subq-snap-preview": 0.05 },
  });
  const subq = resolveBackend("subq");
  assert.equal(subq.name, "subq");
  assert.equal(subq.defaultModel, "subq-snap-preview");
  assert.equal(subq.path, undefined);
  assert.equal(subq.modelsPath, undefined);
  assert.equal(subq.modelsVerifyKey, false);
  assert.deepEqual(subq.limits, { maxQuestions: 16, minChoiceOptions: 2, maxChoiceOptions: 64, maxScoreLevels: 10 });
});

test("a subq request goes to /v1/systemone with the SUBQ_API_KEY bearer and the subq-snap-preview model", async () => {
  let calls = 0;
  const client = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://api.subq.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${sqKey}`);
    const body = JSON.parse(String(init?.body)) as { model: string; questions: Questions };
    assert.equal(body.model, "subq-snap-preview");
    assert.deepEqual(Object.keys(body.questions), ["yes"]);
    return reply(10);
  } });
  const result = await client.evaluate(sample());
  assert.equal(result.answers.yes.noul, 0.9);
  assert.equal(calls, 1);
});

test("a per-request model on subq is sent unchanged", async () => {
  const client = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "jev-latest");
    return reply(10);
  } });
  await client.evaluate({ ...sample(), model: "jev-latest" });
});

test("subq's documented choice and score answers pass validation", async () => {
  const questions = {
    queue: choice("Which team?", { nurse_line: "Nurse", primary_care: "Doctor", front_desk: null }),
    acuity: score("How soon?", ["Within a week", "Within a day", "Within an hour"]),
  };
  const client = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => Response.json({
    model: "subq-snap-preview",
    answers: {
      queue: { type: "choice", choice: "nurse_line", confidence: 0.81, probabilities: { nurse_line: 0.81, primary_care: 0.15, front_desk: 0.04 } },
      acuity: { type: "score", score: 1.6, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, legend: { 0: "Within a week", 1: "Within a day", 2: "Within an hour" } },
    },
    usage: { input_tokens: 120, output_tokens: 0 },
  }) });
  const result = await client.evaluate({ state: "Patient reports shortness of breath.", questions });
  assert.equal(result.answers.queue.choice, "nurse_line");
  assert.equal(result.answers.acuity.score, 1.6);
});

test("subq's error shapes become safe errors that name SUBQ_API_KEY and never quote the body", async () => {
  const detail = (status: number, error_type: string) => async () => Response.json({ detail: { error_type, message: `secret detail ${status}` } }, { status });
  for (const [status, type, advice] of [
    [400, "invalid_request_error", "Check the question format and model limits."],
    [401, "authentication_error", "Check SUBQ_API_KEY."],
    [402, "insufficient_credits", "Check your account balance."],
    [403, "permission_error", "Check your account access and model permissions."],
    [422, "invalid_request_error", "Check the question format and model limits."],
    [429, "rate_limit_error", "Check your account quota and try again later."],
    [503, "server_error", "Try again later or check the service status."],
  ] as const) {
    const client = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: detail(status, type) });
    await assert.rejects(client.evaluate(sample()), (error: unknown) => {
      assert.ok(error instanceof TypeSafeIntegrationError);
      assert.equal(error.code, "http");
      assert.equal(error.status, status);
      assert.equal(error.message, `TypeSafe returned HTTP ${status}. ${advice} No automatic retry was made.`);
      assert.ok(!error.message.includes("secret detail"));
      return true;
    });
  }
  assert.equal(authState({ backend: "subq" }).verified, false);
});

test("subq's public model list is read from /v1/models, renamed from data and id, and verifies nothing", async () => {
  const urls: string[] = [];
  const client = createTypeSafe({ backend: "subq", fetch: async (url) => {
    urls.push(String(url));
    return Response.json({ object: "list", data: [{ id: "subq-snap-preview", object: "model", name: "SubQ Snap Preview" }] });
  } });
  assert.deepEqual(await client.listModels(), ["subq-snap-preview"]);
  assert.deepEqual(urls, ["https://api.subq.ai/v1/models"]);
  assert.equal(authState({ backend: "subq" }).verified, false);
});

test("subq prices subq-snap-preview at $0.05 per million input tokens, in the session and in the ledger", async () => {
  assert.equal(backendPrice(resolveBackend("subq"), "subq-snap-preview"), 0.05);
  const ledger = openUsageLedger({ path: ledgerPath() });
  const client = createTypeSafe({ backend: "subq", ledger, fetch: async () => reply(2_000_000) });
  assert.equal(client.getSpend().usdPerMTok, 0.05);
  await client.evaluate(sample());
  assert.equal(client.getUsage().estimatedUsd, 0.1);
  assert.equal(ledger.today().estimatedUsd, 0.1);
});

test("a client exposes its backend's limits without a request", () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return reply(1);
  };
  assert.equal(createTypeSafe({ backend: "subq", fetch }).limits?.maxQuestions, 16);
  assert.equal(createTypeSafe({ fetch }).limits?.maxQuestions, 32);
  assert.deepEqual(createTypeSafe({ fetch }).limits, DEFAULT_BACKEND_LIMITS);
  assert.equal(resolveBackend("subq").limits.maxQuestions, 16);
  assert.equal(resolveBackend("typesafe").limits.maxQuestions, 32);
  assert.equal(calls, 0);
});

test("17 questions are refused on subq before any fetch, and sent on typesafe", async () => {
  let subqCalls = 0;
  const subq = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    subqCalls += 1;
    return answerAll(init);
  } });
  await assert.rejects(subq.evaluate({ state: "s", questions: manyQuestions(17) }), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "validation");
    assert.equal(error.message, "Evaluation exceeds the backend's limits: 17 questions, at most 16 per request. evaluateAll splits a request to this limit.");
    return true;
  });
  assert.equal(subqCalls, 0);
  assert.equal(subq.getUsage().requestsStarted, 0);
  await subq.evaluate({ state: "s", questions: manyQuestions(16) });
  assert.equal(subqCalls, 1);

  let typesafeCalls = 0;
  const typesafe = createTypeSafe({ ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    typesafeCalls += 1;
    return answerAll(init);
  } });
  await typesafe.evaluate({ state: "s", questions: manyQuestions(17) });
  assert.equal(typesafeCalls, 1);
});

test("subq refuses a 1-option choice and an 11-level score before any fetch; 2 options and 10 levels are sent", async () => {
  let calls = 0;
  const client = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => {
    calls += 1;
    return reply(1);
  } });
  const levels = (count: number) => Array.from({ length: count }, (_, index) => `level ${index}`) as [string, string, ...string[]];
  await assert.rejects(client.evaluate({ state: "s", questions: { pick: choice("Which?", { only: null }) } }), rejects("validation"));
  await assert.rejects(client.evaluate({ state: "s", questions: { rate: score("How much?", levels(11)) } }), rejects("validation"));
  assert.equal(calls, 0);

  const sent: Questions[] = [];
  const open = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    sent.push((JSON.parse(String(init?.body)) as { questions: Questions }).questions);
    return Response.json({ model: "subq-snap-preview", answers: {
      pick: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1, b: 0 } },
      rate: { type: "score", score: 0, confidence: 1, probabilities: Object.fromEntries(levels(10).map((_, i) => [i, i === 0 ? 1 : 0])), legend: Object.fromEntries(levels(10).map((level, i) => [i, level])) },
    }, usage: { input_tokens: 1, output_tokens: 0 } });
  } });
  await open.evaluate({ state: "s", questions: { pick: choice("Which?", { a: null, b: null }), rate: score("How much?", levels(10)) } });
  assert.equal(sent.length, 1);
});

test("evaluateAll on subq splits 17 questions into 16 and 1 and merges the answers", async () => {
  const sizes: number[] = [];
  const client = createTypeSafe({ backend: "subq", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    sizes.push(Object.keys((JSON.parse(String(init?.body)) as { questions: Questions }).questions).length);
    return answerAll(init);
  } });
  const batch = await client.evaluateAll({ state: "s", questions: manyQuestions(17) }, { concurrency: 1 });
  assert.equal(batch.ok, true);
  assert.deepEqual(sizes, [16, 1]);
  assert.equal(Object.keys(batch.answers).length, 17);
  assert.equal(batch.usage.input_tokens, 20);

  sizes.length = 0;
  const capped = await client.evaluateAll({ state: "s", questions: manyQuestions(17) }, { concurrency: 1, maxQuestions: 32 });
  assert.equal(capped.ok, true);
  assert.deepEqual(sizes, [16, 1]);
});

test("chunkEvaluationRequest chunks to 16 for subq and 32 by default", () => {
  const request = { state: "s", questions: manyQuestions(33) };
  assert.deepEqual(chunkEvaluationRequest(request, { backend: "subq" }).map(chunk => Object.keys(chunk.questions).length), [16, 16, 1]);
  assert.deepEqual(chunkEvaluationRequest(request).map(chunk => Object.keys(chunk.questions).length), [32, 1]);
});
