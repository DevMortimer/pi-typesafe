import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTypeSafe, choice, noul, score, normalizeEvaluationRequest, parseEvaluationRequest, TypeSafeIntegrationError } from "../src/index.js";
import type { Questions, SystemOneRequest } from "../src/index.js";

export function responseFor(questions: Questions): Response {
  const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    if (q.type === "noul") return [id, { type: "noul", noul: 0.9 }];
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      return [id, { type: "choice", choice: keys[0], confidence: 1, probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0])) }];
    }
    return [id, { type: "score", score: 0, confidence: 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 1 : 0])), legend: Object.fromEntries(q.criteria.map((level, i) => [i, level])) }];
  }));
  return Response.json({ model: "jev-test", answers, usage: { input_tokens: 42, output_tokens: 0 } });
}
const sample = () => ({ state: "synthetic", questions: { yes: noul("Is this synthetic?") } });
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKey = process.env.TYPESAFE_API_KEY;
before(() => {
  // Keep the developer's real stored key and environment out of these tests.
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-typesafe-client-"));
  delete process.env.TYPESAFE_API_KEY;
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
});
const hasCode = (code: string) => (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === code;

test("official SDK helpers, typed answers, metadata, and one batched network call", async () => {
  let calls = 0;
  const questions = {
    category: choice("Which?", { billing: "Charges", other: null }),
    urgent: noul("Urgent?"),
    frustration: score("Frustration?", ["Calm", "Angry"]),
  };
  const client = createTypeSafe({ apiKey: "test-key", fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.questions, JSON.parse(JSON.stringify(questions)));
    assert.equal(request.model, "jev-latest");
    assert.ok(Object.values(Object.fromEntries(new Headers(init?.headers))).some(value => value.includes("test-key")));
    return responseFor(questions);
  } });
  const result = await client.evaluate({ state: { message: "Example" }, questions });
  const category: "billing" | "other" = result.answers.category.choice;
  const yes: number = result.answers.urgent.noul;
  const value: number = result.answers.frustration.score;
  assert.equal(category, "billing");
  assert.equal(yes, 0.9);
  assert.equal(value, 0);
  assert.equal(calls, 1);
  assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(client.getUsage(), { requestsStarted: 1, requestsSucceeded: 1, requestsFailed: 0, inputTokens: 42, outputTokens: 0, estimatedUsd: 0.000002 });
  const spend = client.getSpend();
  assert.equal(spend.session.requestsStarted, 1);
  assert.equal(spend.today.inputTokens, 42);
  assert.equal(spend.blocked, undefined);
});

test("structured state, descriptions, and null values are supported", () => {
  assert.doesNotThrow(() => parseEvaluationRequest({ state: null, questions: {
    yes: noul({ goal: "Check" }, { true: ["a"], false: null }),
    pick: choice(["Choose"], { a: { detail: "a" }, b: null }),
    rating: score(null, [null, { level: "high" }]),
  } }));
});

test("invalid questions are rejected before network submission without echoing state", async () => {
  const secret = "private-user-content";
  let calls = 0;
  const client = createTypeSafe({ apiKey: "test-key", fetch: async () => { calls++; throw new Error(secret); } });
  const invalid = [
    { state: secret, questions: {} },
    { state: secret, questions: { q: { type: "score", criteria: ["one"] } } },
    { state: secret, questions: { q: { type: "choice", criteria: {} } } },
    { state: secret, questions: { q: { type: "unsupported" } } },
    { state: secret, questions: { q: noul("yes") }, apiKey: secret },
    { state: secret, questions: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, noul("yes")])) },
  ];
  for (const request of invalid) {
    await assert.rejects(() => Reflect.apply(client.evaluate, client, [request]), error => {
      assert.ok(error instanceof TypeSafeIntegrationError);
      assert.equal(error.code, "validation");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
  assert.equal(calls, 0);
  assert.equal(client.getUsage().requestsStarted, 0);
});

test("validation errors name the offending path, never the submitted value", () => {
  const secret = "private-user-content";
  const cases: Array<[unknown, RegExp]> = [
    [{ state: secret, questions: { q: { type: "choice", instructions: secret, criteria: ["a", 1] } } }, /questions\.q/],
    [{ state: secret, questions: { q: { type: "score", criteria: [secret] } } }, /questions\.q/],
    [{ state: secret, questions: {} }, /questions/],
    [{ state: secret }, /questions|request/],
    [{ state: secret, questions: { q: noul("ok") }, extra: secret }, /extra/],
  ];
  for (const [request, path] of cases) {
    assert.throws(() => parseEvaluationRequest(request), (error: unknown) => {
      assert.ok(error instanceof TypeSafeIntegrationError);
      assert.match(error.message, path);
      assert.match(error.message, /Expected \{ state, questions/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test("normalization accepts common model near-misses without loosening the schema", () => {
  const normalized = normalizeEvaluationRequest({
    state: "s",
    questions: {
      team: { type: "choice", instructions: "Which team?", options: ["frontend", "backend"] },
      level: { type: "score", instructions: "How bad?", levels: ["fine", "bad"] },
      flag: { type: "noul", instructions: "Is it?", criteria: "Yes when stated" },
      keep: choice("Already valid", { a: "A", b: null }),
    },
  });
  const request = parseEvaluationRequest(normalized);
  assert.deepEqual(request.questions.team, { type: "choice", instructions: "Which team?", criteria: { frontend: null, backend: null } });
  assert.deepEqual(request.questions.level, { type: "score", instructions: "How bad?", criteria: ["fine", "bad"] });
  assert.deepEqual(request.questions.flag, { type: "noul", instructions: "Is it?", criteria: { true: "Yes when stated" } });
  assert.deepEqual(request.questions.keep, JSON.parse(JSON.stringify(choice("Already valid", { a: "A", b: null }))));
  for (const value of [null, "text", [], { questions: [] }, { questions: { q: "text" } }]) {
    assert.deepEqual(normalizeEvaluationRequest(value), value);
  }
  assert.throws(() => parseEvaluationRequest(normalizeEvaluationRequest({ state: "s", questions: { q: { type: "choice", options: ["a", 2] } } })), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "validation");
});

test("non-JSON state, getters, cycles, and excessive nesting are rejected", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let nested: unknown = null;
  for (let i = 0; i < 70; i++) nested = { nested };
  const invalid = [cycle, { n: NaN }, { n: Infinity }, { n: 1n }, { fn: () => null }, new Date(), nested,
    Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("must not read"); } })];
  for (const state of invalid) assert.throws(() => parseEvaluationRequest({ state, questions: sample().questions }), hasCode("validation"));
});

test("UTF-8 byte limit applies before submission", async () => {
  const client = createTypeSafe({ apiKey: "test-key", maxInputBytes: 180, fetch: async () => { throw new Error("must not run"); } });
  await assert.rejects(client.evaluate({ ...sample(), state: "🙂".repeat(50) }), hasCode("validation"));
  assert.equal(client.getUsage().requestsStarted, 0);
});

test("request budget is shared across concurrent calls and failures", async () => {
  let calls = 0;
  const client = createTypeSafe({ apiKey: "test-key", maxRequests: 2, fetch: async () => {
    calls++;
    return Response.json({ error: "do not display this upstream body" }, { status: 500 });
  } });
  const results = await Promise.allSettled([client.evaluate(sample()), client.evaluate(sample()), client.evaluate(sample())]);
  assert.equal(calls, 2);
  assert.equal(results.filter(result => result.status === "rejected").length, 3);
  await assert.rejects(client.evaluate(sample()), hasCode("budget"));
  assert.equal(client.getUsage().requestsStarted, 2);
  assert.equal(client.getUsage().requestsSucceeded, 0);
});

test("HTTP errors are classified, never retried, and do not expose response secrets", async () => {
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    let calls = 0;
    const client = createTypeSafe({ apiKey: "test-key", fetch: async () => {
      calls++;
      return Response.json({ secret: "never-print-me" }, { status });
    } });
    await assert.rejects(client.evaluate(sample()), error => {
      assert.ok(error instanceof TypeSafeIntegrationError);
      assert.equal(error.code, "http");
      assert.equal(error.status, status);
      assert.equal(JSON.stringify(error).includes("never-print-me"), false);
      assert.equal(String(error).includes("never-print-me"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("cancellation before submission does not consume an attempt", async () => {
  const client = createTypeSafe({ apiKey: "test-key", fetch: async () => { throw new Error("must not run"); } });
  await assert.rejects(client.evaluate(sample(), { signal: AbortSignal.abort() }), hasCode("aborted"));
  assert.equal(client.getUsage().requestsStarted, 0);
});

test("in-flight cancellation and timeout reach the transport", async () => {
  const pending = async (_url: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  });
  const controller = new AbortController();
  const client = createTypeSafe({ apiKey: "test-key", fetch: pending, timeoutMs: 1000 });
  const request = client.evaluate(sample(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, hasCode("aborted"));
  const timed = createTypeSafe({ apiKey: "test-key", fetch: pending, timeoutMs: 10 });
  await assert.rejects(timed.evaluate(sample()), hasCode("timeout"));
});

test("malformed successful responses fail safely", async () => {
  for (const response of [Response.json({ secret: "private" }), new Response("not-json"), Response.json({ model: "test", usage: { input_tokens: 1, output_tokens: 0 }, answers: { yes: { type: "noul", noul: 5 } } })]) {
    const client = createTypeSafe({ apiKey: "test-key", fetch: async () => response });
    await assert.rejects(client.evaluate(sample()), hasCode("response"));
    assert.equal(client.getUsage().requestsSucceeded, 0);
  }
});

test("client ignores SDK endpoint and logging environment overrides", async () => {
  const originalUrl = process.env.TYPESAFE_BASE_URL;
  const originalLog = process.env.TYPESAFE_LOG_LEVEL;
  process.env.TYPESAFE_BASE_URL = "https://untrusted.invalid";
  process.env.TYPESAFE_LOG_LEVEL = "debug";
  try {
    const client = createTypeSafe({ apiKey: "test-key", fetch: async (url) => {
      assert.ok(url.startsWith("https://api.typesafe.ai/"));
      return responseFor(sample().questions);
    } });
    await client.evaluate(sample());
  } finally {
    if (originalUrl === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = originalUrl;
    if (originalLog === undefined) delete process.env.TYPESAFE_LOG_LEVEL; else process.env.TYPESAFE_LOG_LEVEL = originalLog;
  }
});

test("configuration errors are early and usage snapshots are detached", async () => {
  assert.throws(() => createTypeSafe({ apiKey: " " }), hasCode("configuration"));
  for (const options of [{ timeoutMs: 0 }, { maxRequests: -1 }, { maxInputBytes: NaN }, { model: "" }]) {
    assert.throws(() => createTypeSafe({ apiKey: "test-key", ...options }), hasCode("configuration"));
  }
  const client = createTypeSafe({ apiKey: "test-key", fetch: async () => responseFor(sample().questions) });
  const snapshot = client.getUsage();
  await client.evaluate(sample());
  assert.equal(snapshot.requestsStarted, 0);
  assert.equal(client.getUsage().requestsStarted, 1);
});

test("request data is snapshotted before asynchronous work", async () => {
  let sent: SystemOneRequest | undefined;
  const client = createTypeSafe({ apiKey: "test-key", fetch: async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return responseFor(sample().questions);
  } });
  const request = sample();
  const result = client.evaluate(request);
  request.state = "changed";
  await result;
  assert.equal(sent?.state, "synthetic");
});

test("evaluate admits the same near-miss aliases as the agent tool", async () => {
  let sentCriteria: unknown;
  const client = createTypeSafe({ apiKey: "test-key", fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria?: unknown }> };
    sentCriteria = body.questions.yes?.criteria;
    return responseFor(sample().questions);
  } });
  const nearMiss = { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is this synthetic?", criteria: "Is this synthetic data?" } } };
  const result = await client.evaluate(nearMiss as unknown as SystemOneRequest);
  assert.equal((result.answers.yes as { noul: number }).noul, 0.9);
  assert.deepEqual(sentCriteria, { true: "Is this synthetic data?" });
});

test("unknown backend throws configuration error", () => {
  assert.throws(() => createTypeSafe({ apiKey: "test-key", backend: "bogus" as never }), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "configuration");
    assert.match(error.message, /Unknown judgment backend/);
    assert.match(error.message, /bogus/);
    return true;
  });
});

test("known backend is called at its full request URL", async () => {
  // A host does not identify the endpoint: openrouter.ai answers the SDK's own /v1/systemone with an HTML page and status 200.
  const backends = [
    ["typesafe", "https://api.typesafe.ai/v1/systemone"],
    ["openrouter", "https://openrouter.ai/api/alpha/decisions"],
  ] as const;
  for (const [backend, expected] of backends) {
    let capturedUrl = "";
    const client = createTypeSafe({
      apiKey: "test-key",
      backend,
      fetch: async (url) => { capturedUrl = String(url); return responseFor(sample().questions); },
    });
    await client.evaluate(sample());
    assert.equal(capturedUrl, expected);
  }
});

test("openrouter backend uses default model typesafe/jev-1.13", async () => {
  let sentModel: string | undefined;
  const client = createTypeSafe({
    apiKey: "test-key",
    backend: "openrouter",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      sentModel = body.model;
      return responseFor(sample().questions);
    },
  });
  await client.evaluate(sample());
  assert.equal(sentModel, "typesafe/jev-1.13");
});

test("key resolution picks the right env var per backend", () => {
  // With no key set, openrouter backend should complain about OPENROUTER_API_KEY.
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalOR = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.throws(() => createTypeSafe({ backend: "openrouter" }), (error: unknown) => {
      assert.ok(error instanceof TypeSafeIntegrationError);
      assert.match(error.message, /OPENROUTER_API_KEY/);
      return true;
    });
    // Setting the env var for the right backend should get past key resolution.
    process.env.OPENROUTER_API_KEY = "or-test-key-1234567890123456";
    let called = false;
    createTypeSafe({
      backend: "openrouter",
      fetch: async () => { called = true; return responseFor(sample().questions); },
    });
    assert.equal(called, false); // no evaluate yet, just construction
  } finally {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalOR === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalOR;
  }
});
