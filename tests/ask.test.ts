import assert from "node:assert/strict";
import { test } from "node:test";
import { ask, DEFAULT_ASK_TIMEOUT_MS } from "../src/ask.js";
import type { Judge } from "../src/ask.js";
import { TypeSafeIntegrationError } from "../src/errors.js";
import { noul } from "../src/index.js";
import type { Evaluation } from "../src/client.js";
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
