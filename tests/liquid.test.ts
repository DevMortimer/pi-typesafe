import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  authState, backendPrice, clearAuthState, clearStoredApiKey, createTypeSafe, DECISIONS_BACKENDS, DEFAULT_USD_PER_MTOK, localDay, noul, openUsageLedger,
  resolveBackend, TypeSafeIntegrationError,
} from "../src/index.js";

// An obviously fake key; nothing here reaches a network.
const lqKey = "lq_fake_key_0123456789abcdef";
const sample = () => ({ state: "synthetic", questions: { yes: noul("Is this synthetic?") } });
const reply = (inputTokens: number) => Response.json({ model: "d1", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: inputTokens, output_tokens: 0 } });

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKeys = new Map<string, string | undefined>(["TYPESAFE_API_KEY", "LIQUID_API_KEY"].map(name => [name, process.env[name]]));
const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-liquid-"));
let ledgerCount = 0;
const ledgerPath = () => join(workspace, `ledger-${ledgerCount++}.json`);

before(() => {
  process.env.PI_CODING_AGENT_DIR = workspace;
});
beforeEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  process.env.LIQUID_API_KEY = lqKey;
  clearStoredApiKey();
  clearAuthState();
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("the liquid registry entry names Liquid's host, paths, key variable, and prices", () => {
  assert.deepEqual(DECISIONS_BACKENDS.liquid, {
    label: "Liquid AI",
    host: "https://api.liquid.ai",
    keyEnv: "LIQUID_API_KEY",
    path: "/decisions/v1/systemone",
    modelsPath: "/decisions/v1/models",
    modelsVerifyKey: true,
    prices: { d1: 0.04, "d1:free": 0 },
  });
  const liquid = resolveBackend("liquid");
  assert.equal(liquid.name, "liquid");
  assert.equal(liquid.defaultModel, "d1:free");
  assert.equal(liquid.modelsVerifyKey, true);
  assert.equal(liquid.modelsField, undefined);
  assert.equal(liquid.modelsIdField, undefined);
});

test("a liquid request goes to the Liquid path with its own key and the d1:free model", async () => {
  let calls = 0;
  const client = createTypeSafe({ backend: "liquid", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://api.liquid.ai/decisions/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${lqKey}`);
    assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "d1:free");
    return reply(10);
  } });
  await client.evaluate(sample());
  assert.equal(calls, 1);
});

test("a per-request model on liquid is sent unchanged", async () => {
  const client = createTypeSafe({ backend: "liquid", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async (_url, init) => {
    assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, "d1");
    return reply(10);
  } });
  await client.evaluate({ ...sample(), model: "d1" });
});

test("a liquid model list is read from the Liquid path and checks the key", async () => {
  const urls: string[] = [];
  const client = createTypeSafe({ backend: "liquid", fetch: async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${lqKey}`);
    return Response.json({ models: [{ name: "d1" }, { name: "d1:free" }] });
  } });
  assert.deepEqual(await client.listModels(), ["d1", "d1:free"]);
  assert.deepEqual(urls, ["https://api.liquid.ai/decisions/v1/models"]);
  assert.equal(authState({ backend: "liquid" }).verified, true);
});

test("a liquid model list that refuses the key is an error and verifies nothing", async () => {
  const client = createTypeSafe({ backend: "liquid", fetch: async () => Response.json({ error: { message: "bad key", type: "authentication_error", param: null, code: "invalid_api_key" } }, { status: 401 }) });
  await assert.rejects(client.listModels(), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.status, 401);
    assert.ok(error.message.includes("LIQUID_API_KEY"));
    return true;
  });
  assert.equal(authState({ backend: "liquid" }).verified, false);
});

test("liquid prices the default model at 0, d1 at 0.04, and a model with no price at the default", () => {
  const liquid = resolveBackend("liquid");
  assert.equal(backendPrice(liquid, "d1:free"), 0);
  assert.equal(backendPrice(liquid, "d1"), 0.04);
  assert.equal(backendPrice(liquid, "other"), undefined);
  assert.equal(backendPrice(liquid, "constructor"), undefined);
  assert.equal(backendPrice(resolveBackend("typesafe"), "jev-latest"), undefined);
  const fetch = async () => reply(1);
  assert.equal(createTypeSafe({ backend: "liquid", fetch }).getSpend().usdPerMTok, 0);
  assert.equal(createTypeSafe({ backend: "liquid", model: "d1", fetch }).getSpend().usdPerMTok, 0.04);
  assert.equal(createTypeSafe({ backend: "liquid", model: "other", fetch }).getSpend().usdPerMTok, DEFAULT_USD_PER_MTOK);
  process.env.TYPESAFE_API_KEY = "ts_fake_key_0123456789abcdef";
  assert.equal(createTypeSafe({ fetch }).getSpend().usdPerMTok, DEFAULT_USD_PER_MTOK);
});

test("a request is priced at the model it sends, in the session and in the ledger", async () => {
  const ledger = openUsageLedger({ path: ledgerPath() });
  const client = createTypeSafe({ backend: "liquid", ledger, fetch: async () => reply(1_000_000) });
  await client.evaluate(sample());
  assert.equal(client.getUsage().estimatedUsd, 0);
  assert.equal(ledger.today().estimatedUsd, 0);
  await client.evaluate({ ...sample(), model: "d1" });
  assert.equal(client.getUsage().estimatedUsd, 0.04);
  assert.equal(client.getUsage().inputTokens, 2_000_000);
  assert.equal(ledger.today().estimatedUsd, 0.04);
});

test("a caller's usdPerMTok takes precedence over the backend's price, and 0 is accepted", async () => {
  const ledger = openUsageLedger({ path: ledgerPath() });
  const paid = createTypeSafe({ backend: "liquid", usdPerMTok: 2, ledger, fetch: async () => reply(1_000_000) });
  assert.equal(paid.getSpend().usdPerMTok, 2);
  await paid.evaluate(sample());
  assert.equal(paid.getUsage().estimatedUsd, 2);
  assert.equal(ledger.today().estimatedUsd, 2);

  const free = createTypeSafe({ backend: "liquid", usdPerMTok: 0, ledger, fetch: async () => reply(1_000_000) });
  assert.equal(free.getSpend().usdPerMTok, 0);
  await free.evaluate({ ...sample(), model: "d1" });
  assert.equal(free.getUsage().estimatedUsd, 0);
  assert.equal(ledger.today().estimatedUsd, 2);

  for (const usdPerMTok of [-1, Number.NaN]) {
    assert.throws(() => createTypeSafe({ backend: "liquid", usdPerMTok, fetch: async () => reply(1) }), (error: unknown) => {
      assert.ok(error instanceof TypeSafeIntegrationError);
      assert.equal(error.message, "usdPerMTok must be a non-negative number.");
      return true;
    });
  }
});

test("one ledger keeps each request's own cost across models and backends, and free requests never reach the USD cap", async () => {
  const path = ledgerPath();
  const liquid = createTypeSafe({ backend: "liquid", maxUsdPerDay: 0.05, ledger: openUsageLedger({ path }), fetch: async () => reply(1_000_000) });
  // Many free tokens, no spend: the cap is untouched.
  for (let i = 0; i < 3; i += 1) await liquid.evaluate(sample());
  assert.equal(liquid.getSpend().today.estimatedUsd, 0);
  assert.equal(liquid.getSpend().blocked, undefined);

  await liquid.evaluate({ ...sample(), model: "d1" });
  assert.equal(liquid.getSpend().today.estimatedUsd, 0.04);

  // A TypeSafe client with another price writes to the same file; the day's spend is the sum of what each paid.
  const typesafe = createTypeSafe({ apiKey: "ts_fake_key_0123456789abcdef", ledger: openUsageLedger({ path }), fetch: async () => reply(1_000_000) });
  await typesafe.evaluate(sample());
  const total = openUsageLedger({ path }).today();
  assert.equal(total.inputTokens, 5_000_000);
  assert.equal(total.estimatedUsd, 0.082);

  // 0.082 is over the 0.05 cap: the next request, even a free one, is stopped by the cap that was reached.
  const capped = createTypeSafe({ backend: "liquid", maxUsdPerDay: 0.05, ledger: openUsageLedger({ path }), fetch: async () => reply(1) });
  await assert.rejects(capped.evaluate(sample()), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "budget");
    return true;
  });

  // On a ledger that holds only free requests, the same cap never blocks.
  const freeOnly = createTypeSafe({ backend: "liquid", maxUsdPerDay: 0.0001, ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => reply(50_000_000) });
  await freeOnly.evaluate(sample());
  await freeOnly.evaluate(sample());
  assert.equal(freeOnly.getSpend().blocked, undefined);
});

test("a ledger file written before costs were recorded is still estimated at the ledger's rate", async () => {
  const path = ledgerPath();
  const day = localDay();
  writeFileSync(path, JSON.stringify({ version: 1, days: { [day]: { requestsStarted: 1, requestsSucceeded: 1, requestsFailed: 0, inputTokens: 1_000_000, outputTokens: 0 } } }));
  const ledger = openUsageLedger({ path });
  assert.equal(ledger.today().estimatedUsd, DEFAULT_USD_PER_MTOK);
  assert.equal(ledger.blocked({ maxUsdPerDay: 0.04 })?.cap, "usdPerDay");

  // New requests add their own cost; the old tokens are not re-priced and the free ones add nothing.
  const client = createTypeSafe({ backend: "liquid", ledger, fetch: async () => reply(1_000_000) });
  await client.evaluate(sample());
  assert.equal(ledger.today().estimatedUsd, DEFAULT_USD_PER_MTOK);
  await client.evaluate({ ...sample(), model: "d1" });
  assert.equal(ledger.today().estimatedUsd, 0.082);
  assert.equal(openUsageLedger({ path }).today().estimatedUsd, 0.082);

  // An older ledger instance's way of recording, with no cost, still works.
  const legacy = openUsageLedger({ path: ledgerPath(), usdPerMTok: 1 });
  legacy.recordSuccess(1_000_000, 0);
  assert.equal(legacy.today().estimatedUsd, 1);
  const stored = JSON.parse(readFileSync(path, "utf8")) as { days: Record<string, Record<string, unknown>> };
  assert.equal(stored.days[day]?.costedInputTokens, 2_000_000);
});
