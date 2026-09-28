import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  authState, backendHost, clearAuthState, clearStoredApiKey, createTypeSafe, keySituation,
  noul, resolveBackend, storeApiKey, TypeSafeIntegrationError,
} from "../src/index.js";
import type { BackendEndpoint, BackendSpec, Questions } from "../src/index.js";
import { safeError } from "../src/errors.js";
import { APIError } from "@typesafe-ai/sdk";

function responseFor(questions: Questions): Response {
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
const gateway: BackendEndpoint = { label: "Gateway", host: "https://gw.example.com", path: "/jev/v1/systemone", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" };
// Obviously fake keys only; nothing here ever reaches a network.
const ccKey = "cc_fake_key_0123456789abcdef";
const gwKey = "gw_fake_key_0123456789abcdef";
const tsKey = "ts_fake_key_0123456789abcdef";
const storedKey = "st_fake_key_0123456789abcdef";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedEnv = new Map<string, string | undefined>(["TYPESAFE_API_KEY", "COMMANDCODE_API_KEY", "GATEWAY_JEV_KEY"].map(name => [name, process.env[name]]));
before(() => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-typesafe-backends-"));
});
beforeEach(() => {
  for (const name of ["TYPESAFE_API_KEY", "COMMANDCODE_API_KEY", "GATEWAY_JEV_KEY"]) delete process.env[name];
  clearStoredApiKey();
  clearAuthState();
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function assertRefuses(backend: unknown, message: string, options: { apiKey?: string; model?: string } = {}): void {
  let fetchCalls = 0;
  const fetch = async () => { fetchCalls += 1; return new Response("{}"); };
  assert.throws(() => createTypeSafe({
    backend: backend as BackendSpec,
    fetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.model === undefined ? {} : { model: options.model }),
  }), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "configuration");
    assert.equal(error.message, message);
    assert.ok(!error.message.includes("user:pw"));
    return true;
  });
  assert.equal(fetchCalls, 0);
}

// 1. Command Code request.

test("a commandcode request goes to the Command Code path with its own key and model", async () => {
  process.env.COMMANDCODE_API_KEY = ccKey;
  const questions = sample().questions;
  let calls = 0;
  const client = createTypeSafe({ backend: "commandcode", fetch: async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://api.commandcode.ai/provider/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${ccKey}`);
    assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "typesafe/jev");
    return responseFor(questions);
  } });
  await client.evaluate(sample());
  assert.equal(calls, 1);
});

test("a per-request model on commandcode is sent unchanged", async () => {
  process.env.COMMANDCODE_API_KEY = ccKey;
  const questions = sample().questions;
  const client = createTypeSafe({ backend: "commandcode", fetch: async (_url, init) => {
    assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "jev-2.0");
    return responseFor(questions);
  } });
  await client.evaluate({ ...sample(), model: "jev-2.0" });
});

// 2. Custom object.

test("a caller-supplied endpoint sends to its own path with its own key and unmapped model", async () => {
  process.env.GATEWAY_JEV_KEY = gwKey;
  const questions = sample().questions;
  let calls = 0;
  const client = createTypeSafe({ backend: gateway, fetch: async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://gw.example.com/jev/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${gwKey}`);
    assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "jev-latest");
    return responseFor(questions);
  } });
  await client.evaluate(sample());
  assert.equal(calls, 1);
});

test("an endpoint without a path uses the SDK's own /v1/systemone", async () => {
  process.env.GATEWAY_JEV_KEY = gwKey;
  const questions = sample().questions;
  let sentUrl = "";
  const client = createTypeSafe({ backend: { label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" }, fetch: async (url) => {
    sentUrl = String(url);
    return responseFor(questions);
  } });
  await client.evaluate(sample());
  assert.equal(sentUrl, "https://gw.example.com/v1/systemone");
});

test("an endpoint may use a loopback http: host", async () => {
  process.env.GATEWAY_JEV_KEY = gwKey;
  const questions = sample().questions;
  let sentUrl = "";
  const client = createTypeSafe({ backend: { label: "Local", host: "http://127.0.0.1:8787", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" }, fetch: async (url) => {
    sentUrl = String(url);
    return responseFor(questions);
  } });
  await client.evaluate(sample());
  assert.equal(sentUrl, "http://127.0.0.1:8787/v1/systemone");
});

// 3. Every refusal in the validation table.

const hostMessage = "Backend host must be an absolute https: URL with no user info, path, query, or fragment (http: is allowed only for localhost, 127.0.0.0/8, and [::1]).";

test("an endpoint label must be a nonempty string of at most 60 characters", () => {
  for (const label of [7, "", "   ", "x".repeat(61)]) {
    assertRefuses({ label, host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" }, "Backend label must be a nonempty string of at most 60 characters.");
  }
});

test("an endpoint host must be an absolute https: URL with no user info, path, query, or fragment", () => {
  for (const host of ["http://gw.example.com", "https://user:pw@gw.example.com", "https://gw.example.com/prefix", "https://gw.example.com?x=1", "https://gw.example.com#f", "ftp://gw.example.com", "not a url"]) {
    assertRefuses({ label: "Gateway", host, keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" }, hostMessage);
  }
});

test('an endpoint path must be a string that starts with "/"', () => {
  for (const path of ["jev", "x?q", "x#f", 7]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest", path }, 'Backend path must be a string that starts with "/".');
  }
});

test('an endpoint modelsPath must be a string that starts with "/"', () => {
  for (const modelsPath of ["models", "x?q", 7]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest", modelsPath }, 'Backend modelsPath must be a string that starts with "/".');
  }
});

test("an endpoint modelsField must be a nonempty string", () => {
  for (const modelsField of ["", 7]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest", modelsField }, "Backend modelsField must be a nonempty string.");
  }
});

test("an endpoint modelsIdField must be a nonempty string", () => {
  for (const modelsIdField of ["", 7]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest", modelsIdField }, "Backend modelsIdField must be a nonempty string.");
  }
});

test("an endpoint modelsVerifyKey must be a boolean", () => {
  for (const modelsVerifyKey of ["yes", 1]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest", modelsVerifyKey }, "Backend modelsVerifyKey must be a boolean.");
  }
});

test("an endpoint keyEnv must name an environment variable", () => {
  for (const keyEnv of ["1BAD", "GATEWAY KEY", ""]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv, defaultModel: "jev-latest" }, "Backend keyEnv must name an environment variable: letters, digits, and underscores, not starting with a digit.");
  }
});

test("an endpoint keyEnv must not be TYPESAFE_API_KEY", () => {
  const message = "Backend keyEnv must not be TYPESAFE_API_KEY: the TypeSafe key is only sent to the typesafe backend. Give this endpoint its own variable.";
  for (const keyEnv of ["TYPESAFE_API_KEY", "typesafe_api_key"]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv, defaultModel: "jev-latest" }, message);
  }
});

test("an endpoint defaultModel must be a nonempty string of at most 100 characters", () => {
  for (const defaultModel of ["", "   ", "x".repeat(101), 7]) {
    assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel }, "Backend defaultModel must be a nonempty string of at most 100 characters.");
  }
});

test("an endpoint with no defaultModel needs model on createTypeSafe", () => {
  assertRefuses({ label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY" }, 'Backend "Gateway" names no defaultModel; pass model to createTypeSafe.', { apiKey: "fake_key_0123456789abcdef" });
});

test("backend must be a registry name or a backend object", () => {
  for (const backend of [42, null, true]) {
    assertRefuses(backend, "backend must be a registry name or a backend object.");
  }
  // An unknown name keeps the registry's own error.
  assertRefuses("unknown-backend", 'Unknown judgment backend "unknown-backend". Valid backends: typesafe, openrouter, commandcode.');
});

test("authState refuses an invalid backend instead of reporting a status", () => {
  assert.throws(() => authState({ backend: { label: "x", host: "http://evil.example", keyEnv: "K" } }), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "configuration");
    assert.equal(error.message, "Backend host must be an absolute https: URL with no user info, path, query, or fragment (http: is allowed only for localhost, 127.0.0.0/8, and [::1]).");
    return true;
  });
});

// 4. Key isolation.

test("an endpoint never reads TYPESAFE_API_KEY or the login store", () => {
  process.env.TYPESAFE_API_KEY = tsKey;
  storeApiKey(storedKey);
  let fetchCalls = 0;
  const fetch = async () => { fetchCalls += 1; return new Response("{}"); };
  assert.throws(() => createTypeSafe({ backend: { label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" }, fetch }), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "configuration");
    assert.equal(error.message, "No API key. Set GATEWAY_JEV_KEY in the environment.");
    return true;
  });
  assert.equal(fetchCalls, 0);
  assert.equal(keySituation(gateway).kind, "missing");
  assert.equal(authState({ backend: gateway }).usable, false);
});

test("commandcode with no COMMANDCODE_API_KEY is missing and unusable", () => {
  process.env.TYPESAFE_API_KEY = tsKey;
  storeApiKey(storedKey);
  let fetchCalls = 0;
  const fetch = async () => { fetchCalls += 1; return new Response("{}"); };
  assert.throws(() => createTypeSafe({ backend: "commandcode", fetch }), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "configuration");
    assert.equal(error.message, "No API key. Set COMMANDCODE_API_KEY in the environment.");
    return true;
  });
  assert.equal(fetchCalls, 0);
  assert.equal(keySituation("commandcode").kind, "missing");
  assert.equal(authState({ backend: "commandcode" }).usable, false);
});

test("a request to an endpoint carries its own key, never the TypeSafe key", async () => {
  process.env.TYPESAFE_API_KEY = tsKey;
  process.env.GATEWAY_JEV_KEY = gwKey;
  storeApiKey(storedKey);
  const questions = sample().questions;
  let calls = 0;
  const client = createTypeSafe({ backend: gateway, fetch: async (_url, init) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    for (const value of headers.values()) {
      assert.ok(!value.includes(tsKey), "the TypeSafe key must never reach another backend");
      assert.ok(!value.includes(storedKey), "the stored login key must never reach another backend");
    }
    assert.equal(headers.get("authorization"), `Bearer ${gwKey}`);
    return responseFor(questions);
  } });
  await client.evaluate(sample());
  assert.equal(calls, 1);
});

// 5. A model list does not verify the key.

test("a public model list on commandcode leaves the auth state unverified", async () => {
  process.env.COMMANDCODE_API_KEY = ccKey;
  const client = createTypeSafe({ backend: "commandcode", fetch: async () => Response.json({ data: [{ id: "typesafe/jev" }] }) });
  assert.deepEqual(await client.listModels(), ["typesafe/jev"]);
  const state = authState({ backend: "commandcode" });
  assert.equal(state.verified, false);
  assert.equal(state.verifiedAt, undefined);
});

test("a model list on an endpoint without modelsVerifyKey leaves the auth state unverified", async () => {
  process.env.GATEWAY_JEV_KEY = gwKey;
  const client = createTypeSafe({ backend: { label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" }, fetch: async () => Response.json({ models: [{ name: "jev-latest" }] }) });
  assert.deepEqual(await client.listModels(), ["jev-latest"]);
  const state = authState({ backend: gateway });
  assert.equal(state.verified, false);
  assert.equal(state.verifiedAt, undefined);
});

test("an endpoint with modelsVerifyKey true records verification", async () => {
  process.env.GATEWAY_JEV_KEY = gwKey;
  const endpoint: BackendEndpoint = { label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest", modelsVerifyKey: true };
  const client = createTypeSafe({ backend: endpoint, fetch: async () => Response.json({ models: [{ name: "jev-latest" }] }) });
  await client.listModels();
  const state = authState({ backend: endpoint });
  assert.equal(state.verified, true);
  assert.ok(state.verifiedAt);
});

test("a successful evaluate records verification even after a public model list", async () => {
  process.env.COMMANDCODE_API_KEY = ccKey;
  const questions = sample().questions;
  const client = createTypeSafe({ backend: "commandcode", fetch: async (url) => String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "typesafe/jev" }] })
    : responseFor(questions) });
  await client.listModels();
  assert.equal(authState({ backend: "commandcode" }).verified, false);
  await client.evaluate(sample());
  assert.equal(authState({ backend: "commandcode" }).verified, true);
});

// 6. Malformed replies stay `response` errors.

test("a malformed reply on commandcode is a response error", async () => {
  process.env.COMMANDCODE_API_KEY = ccKey;
  const client = createTypeSafe({ backend: "commandcode", fetch: async () => Response.json({ model: "jev-test", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }) });
  await assert.rejects(client.evaluate(sample()), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "response");
    return true;
  });
});

test("a malformed reply on an endpoint is a response error", async () => {
  process.env.GATEWAY_JEV_KEY = gwKey;
  const client = createTypeSafe({ backend: gateway, fetch: async () => Response.json({ model: "jev-test", answers: { yes: { type: "noul", noul: 2 } }, usage: { input_tokens: 1, output_tokens: 0 } }) });
  await assert.rejects(client.evaluate(sample()), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "response");
    return true;
  });
});

// 7. 401 advice names each backend's own key variable.

test("401 advice names each backend's own key variable", () => {
  assert.equal(safeError(new APIError(401, undefined, new Headers()), "commandcode").message, "TypeSafe returned HTTP 401. Check COMMANDCODE_API_KEY. No automatic retry was made.");
  assert.equal(safeError(new APIError(401, undefined, new Headers()), gateway).message, "TypeSafe returned HTTP 401. Check GATEWAY_JEV_KEY. No automatic retry was made.");
});

// 8. resolveBackend and backendHost.

test("resolveBackend resolves registry names to the registry entries", () => {
  const typesafe = resolveBackend("typesafe");
  assert.equal(typesafe.name, "typesafe");
  assert.equal(typesafe.label, "TypeSafe");
  assert.equal(typesafe.host, "https://api.typesafe.ai");
  assert.equal(typesafe.keyEnv, "TYPESAFE_API_KEY");
  assert.equal(typesafe.defaultModel, "jev-latest");
  assert.equal(typesafe.modelsVerifyKey, true);
  assert.equal(typesafe.path, undefined);
  const commandcode = resolveBackend("commandcode");
  assert.equal(commandcode.name, "commandcode");
  assert.equal(commandcode.label, "Command Code");
  assert.equal(commandcode.host, "https://api.commandcode.ai");
  assert.equal(commandcode.keyEnv, "COMMANDCODE_API_KEY");
  assert.equal(commandcode.path, "/provider/v1/systemone");
  assert.equal(commandcode.modelsPath, "/provider/v1/models");
  assert.equal(commandcode.modelsField, "data");
  assert.equal(commandcode.modelsIdField, "id");
  assert.equal(commandcode.defaultModel, "typesafe/jev");
  assert.equal(commandcode.modelsVerifyKey, false);
  assert.deepEqual(resolveBackend("openrouter").defaultModel, "typesafe/jev-1.13");
});

test("backendHost reports the destination host", () => {
  assert.equal(backendHost("commandcode"), "api.commandcode.ai");
  assert.equal(backendHost("typesafe"), "api.typesafe.ai");
  assert.equal(backendHost("openrouter"), "openrouter.ai");
  assert.equal(backendHost(gateway), "gw.example.com");
  assert.equal(backendHost({ label: "Gateway", host: "https://gw.example.com:8443", keyEnv: "GATEWAY_JEV_KEY" }), "gw.example.com:8443");
  assert.equal(backendHost({ label: "Local", host: "http://127.0.0.1:8787", keyEnv: "GATEWAY_JEV_KEY" }), "127.0.0.1:8787");
});
