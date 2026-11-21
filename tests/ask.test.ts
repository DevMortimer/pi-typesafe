import assert from "node:assert/strict";
import { test } from "node:test";
import { ask, DEFAULT_ASK_TIMEOUT_MS } from "../src/ask.js";
import type { Judge } from "../src/ask.js";
import { TypeSafeIntegrationError, classifyError, safeError } from "../src/errors.js";
import type { ErrorDisposition } from "../src/errors.js";
import { noul } from "../src/index.js";
import type { Evaluation } from "../src/client.js";
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";

const request: SystemOneRequest<Questions> = { state: "synthetic", questions: { yes: noul("Is this synthetic?") } };
const result: SystemOneResult<Questions> = {
  model: "jev-test",
  answers: { yes: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 12, output_tokens: 0 },
};

function judgeReturning(value: SystemOneResult<Questions>): Judge {
  return { evaluate: async <Q extends Questions>(): Promise<Evaluation<Q>> => ({ ...value, elapsedMs: 7 } as Evaluation<Q>) };
}

test("a successful ask returns the typed answers, model, usage, and duration", async () => {
  const answer = await ask(judgeReturning(result), request);
  assert.equal(answer.ok, true);
  assert.ok(answer.ok);
  const yes = answer.answers.yes;
  assert.equal(yes?.type === "noul" ? yes.noul : undefined, 0.9);
  assert.equal(answer.model, "jev-test");
  assert.equal(answer.usage.input_tokens, 12);
  assert.equal(answer.elapsedMs, 7);
});

test("a typed failure comes back as data, with pi-typesafe's own code and message", async () => {
  const budget = await ask({ evaluate: async () => { throw new TypeSafeIntegrationError("budget", "TypeSafe request limit reached (1 attempts per client instance)."); } }, request);
  assert.deepEqual(budget, { ok: false, error: "TypeSafe request limit reached (1 attempts per client instance).", errorCode: "budget" });
  const http = await ask({ evaluate: async () => { throw new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.", 401); } }, request);
  assert.equal(http.ok, false);
  assert.equal(http.ok === false && http.errorCode, "http");
});

test("an unknown failure is replaced by a fixed message so nothing from the transport escapes", async () => {
  const answer = await ask({ evaluate: async () => { throw new Error("upstream body with a key: sk-secret"); } }, request);
  assert.deepEqual(answer, { ok: false, error: "TypeSafe request failed." });
  assert.equal(JSON.stringify(answer).includes("sk-secret"), false);
});

test("the ask deadline and the caller's signal both cancel the request", async () => {
  const slow: Judge = {
    evaluate: async <Q extends Questions>(_request: SystemOneRequest<Q>, options?: { signal?: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new TypeSafeIntegrationError("aborted", "TypeSafe request cancelled before submission.")), { once: true });
      });
      throw new Error("unreachable");
    },
  };
  const timedOut = await ask(slow, request, { timeoutMs: 5 });
  assert.deepEqual(timedOut, { ok: false, error: "TypeSafe request cancelled before submission.", errorCode: "aborted" });

  const controller = new AbortController();
  const aborted = ask(slow, request, { signal: controller.signal, timeoutMs: 5_000 });
  controller.abort();
  assert.equal((await aborted).ok, false);
  assert.equal(DEFAULT_ASK_TIMEOUT_MS, 15_000);
});

test("classifyError and TypeSafeIntegrationError.disposition classify every transient and permanent error", async () => {
  const cases: ReadonlyArray<[string, unknown, ErrorDisposition]> = [
    ["timeout", new TypeSafeIntegrationError("timeout", "TypeSafe request timed out."), { status: "transient", retryable: true }],
    ["connection", new TypeSafeIntegrationError("connection", "Could not connect."), { status: "transient", retryable: true }],
    ["http 408", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 408.", 408), { status: "transient", retryable: true }],
    ["http 429 plain", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 429. Check your account quota and try again later. No automatic retry was made.", 429), { status: "transient", retryable: true }],
    ["http 429 Retry-After", safeError(new APIError(429, undefined, new Headers({ "retry-after": "7" }))), { status: "transient", retryable: true, retryAfterSeconds: 7 }],
    ["http 503", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 503.", 503), { status: "transient", retryable: true }],
    ["http 503 Retry-After", safeError(new APIError(503, undefined, new Headers({ "retry-after": "12" }))), { status: "transient", retryable: true, retryAfterSeconds: 12 }],
    ["http 401", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 401.", 401), { status: "permanent", retryable: false, target: "credentials" }],
    ["http 402", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 402.", 402), { status: "permanent", retryable: false, target: "billing" }],
    ["http 403", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 403.", 403), { status: "permanent", retryable: false, target: "permission" }],
    ["http 400", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 400.", 400), { status: "permanent", retryable: false, target: "validation" }],
    ["http 404", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 404.", 404), { status: "permanent", retryable: false, target: "validation" }],
    ["http 422", new TypeSafeIntegrationError("http", "TypeSafe returned HTTP 422.", 422), { status: "permanent", retryable: false, target: "validation" }],
    ["configuration", new TypeSafeIntegrationError("configuration", "No API key."), { status: "permanent", retryable: false, target: "configuration" }],
    ["validation", new TypeSafeIntegrationError("validation", "Bad request."), { status: "permanent", retryable: false, target: "validation" }],
    ["budget", new TypeSafeIntegrationError("budget", "Cap reached."), { status: "permanent", retryable: false, target: "budget" }],
    ["aborted", new TypeSafeIntegrationError("aborted", "Cancelled."), { status: "permanent", retryable: false, target: "cancelled" }],
    ["response", new TypeSafeIntegrationError("response", "Malformed."), { status: "permanent", retryable: false, target: "response" }],
    ["SDK timeout", new APITimeoutError(15_000), { status: "transient", retryable: true }],
    ["SDK connection", new APIConnectionError("offline"), { status: "transient", retryable: true }],
    ["SDK abort", new APIUserAbortError("cancelled"), { status: "permanent", retryable: false, target: "cancelled" }],
    ["SDK 429", new APIError(429, undefined, new Headers({ "retry-after": "9" })), { status: "transient", retryable: true, retryAfterSeconds: 9 }],
    ["unknown", new Error("boom"), { status: "permanent", retryable: false, target: "response" }],
  ];
  for (const [label, input, expected] of cases) {
    assert.deepEqual(classifyError(input), expected, label);
    if (input instanceof TypeSafeIntegrationError) {
      assert.deepEqual(input.disposition, expected, `${label}: .disposition`);
      assert.equal(input.retryable, expected.retryable, `${label}: .retryable`);
    }
  }

  // Prototype getters stay non-enumerable so JSON.stringify and Object.keys are unchanged.
  const err = safeError(new APIError(429, undefined, new Headers({ "retry-after": "7" })));
  assert.equal(Object.getOwnPropertyDescriptor(TypeSafeIntegrationError.prototype, "disposition")?.enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(TypeSafeIntegrationError.prototype, "retryable")?.enumerable, false);
  assert.equal(Object.keys(err).includes("disposition"), false);
  assert.equal(Object.keys(err).includes("retryable"), false);
  assert.equal(JSON.stringify(err).includes("disposition"), false);

  // classifyError also accepts failed AskAnswer envelopes without changing their deepEqual shape.
  const ask429 = await ask({ evaluate: async () => { throw err; } }, request);
  assert.deepEqual(ask429, { ok: false, error: err.message, errorCode: "http" });
  assert.deepEqual(classifyError(ask429), { status: "transient", retryable: true, retryAfterSeconds: 7 });

  const ask503 = await ask({ evaluate: async () => { throw safeError(new APIError(503, undefined, new Headers({ "retry-after": "12" }))); } }, request);
  assert.deepEqual(classifyError(ask503), { status: "transient", retryable: true, retryAfterSeconds: 12 });

  const plain401 = { ok: false as const, errorCode: "http" as const, error: "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made." };
  assert.deepEqual(classifyError(plain401), { status: "permanent", retryable: false, target: "credentials" });

  const plain429 = { ok: false as const, errorCode: "http" as const, error: "TypeSafe returned HTTP 429. Check your account quota and try again later. Retry after 7 seconds. No automatic retry was made." };
  assert.deepEqual(classifyError(plain429), { status: "transient", retryable: true, retryAfterSeconds: 7 });

  const plainUnknown = { ok: false as const, error: "TypeSafe request failed." };
  assert.deepEqual(classifyError(plainUnknown), { status: "permanent", retryable: false, target: "response" });
});
