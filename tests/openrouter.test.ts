import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTypeSafe, DECISIONS_BACKENDS, DEFAULT_USD_PER_MTOK, noul, openUsageLedger, resolveBackend, TypeSafeIntegrationError } from "../src/index.js";
import type { BackendEndpoint, TypeSafeBackend } from "../src/index.js";

// An obviously fake key; nothing here reaches a network.
const apiKey = "or_fake_key_0123456789abcdef";
const sample = () => ({ state: "synthetic", questions: { yes: noul("Is this synthetic?") } });
/** A Decisions reply whose `usage` carries `extra` next to the token counts; a string `extra` is spliced in raw, for values JSON.stringify cannot write. */
const reply = (inputTokens: number | null, extra: Record<string, unknown> | string = {}) => {
  const fields = typeof extra === "string" ? extra : JSON.stringify(extra).slice(1, -1);
  const usage = `{"input_tokens":${JSON.stringify(inputTokens)},"output_tokens":20${fields ? `,${fields}` : ""}}`;
  return new Response(`{"id":"gen-dec-test","provider":"TypeSafe","model":"typesafe/jev-1.13-20260917","answers":{"yes":{"type":"noul","noul":0.98}},"usage":${usage}}`, { headers: { "content-type": "application/json" } });
};

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-openrouter-"));
let ledgerCount = 0;
const ledgerPath = () => join(workspace, `ledger-${ledgerCount++}.json`);
before(() => {
  process.env.PI_CODING_AGENT_DIR = workspace;
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

test("only the openrouter registry entry reports what it billed, and a caller-supplied endpoint cannot claim to", () => {
  for (const [name, entry] of Object.entries(DECISIONS_BACKENDS)) {
    assert.equal(entry.reportsCost, name === "openrouter" ? true : undefined, name);
    assert.equal(resolveBackend(name as TypeSafeBackend).reportsCost, entry.reportsCost, name);
  }
  const endpoint = { label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest", reportsCost: true } as BackendEndpoint;
  assert.equal(resolveBackend(endpoint).reportsCost, undefined);
});

test("OpenRouter's reported cost is what the session, the ledger, and a fresh ledger instance record", async () => {
  const path = ledgerPath();
  const ledger = openUsageLedger({ path });
  // A million input tokens would be estimated at 0.042; OpenRouter billed 0.00003.
  const client = createTypeSafe({ apiKey, backend: "openrouter", ledger, fetch: async () => reply(1_000_000, { cost: 0.00003 }) });
  const result = await client.evaluate(sample());
  assert.equal(result.answers.yes.noul, 0.98);
  assert.deepEqual(client.getUsage(), { requestsStarted: 1, requestsSucceeded: 1, requestsFailed: 0, inputTokens: 1_000_000, outputTokens: 20, estimatedUsd: 0.00003 });
  assert.equal(ledger.today().estimatedUsd, 0.00003);
  assert.equal(openUsageLedger({ path }).today().estimatedUsd, 0.00003);
  assert.match(ledger.describe({}), /~\$0\.0000;/);

  // A cost with no token count is still the cost: the request is recorded at what it was billed, with nothing to count.
  const uncounted = createTypeSafe({ apiKey, backend: "openrouter", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => reply(null, { cost: 0.01 }) });
  await uncounted.evaluate(sample());
  assert.equal(uncounted.getUsage().inputTokens, 0);
  assert.equal(uncounted.getUsage().estimatedUsd, 0.01);
  assert.equal(uncounted.getSpend().today.estimatedUsd, 0.01);

  // A reported zero is a free request, not a missing cost.
  const free = createTypeSafe({ apiKey, backend: "openrouter", ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => reply(1_000_000, { cost: 0 }) });
  await free.evaluate(sample());
  assert.equal(free.getUsage().estimatedUsd, 0);
});

test("the daily USD cap follows what OpenRouter billed, not the estimate", async () => {
  // Ten input tokens estimate to well under a micro-dollar; each request was billed 0.03, so the third is stopped.
  const client = createTypeSafe({ apiKey, backend: "openrouter", maxUsdPerDay: 0.05, ledger: openUsageLedger({ path: ledgerPath() }), fetch: async () => reply(10, { cost: 0.03 }) });
  await client.evaluate(sample());
  await client.evaluate(sample());
  assert.equal(client.getSpend().today.estimatedUsd, 0.06);
  assert.deepEqual(client.getSpend().blocked, { cap: "usdPerDay", limit: 0.05, used: 0.06, day: client.getSpend().today.day });
  await assert.rejects(client.evaluate(sample()), (error: unknown) => {
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "budget");
    assert.match(error.message, /^OpenRouter daily spend cap reached \(0\.06 of 0\.05 on /);
    return true;
  });
  assert.equal(client.getUsage().requestsStarted, 2);
});

test("a reported cost takes precedence over the caller's usdPerMTok", async () => {
  const ledger = openUsageLedger({ path: ledgerPath() });
  const client = createTypeSafe({ apiKey, backend: "openrouter", usdPerMTok: 2, ledger, fetch: async () => reply(1_000_000, { cost: 0.00003 }) });
  assert.equal(client.getSpend().usdPerMTok, 2);
  await client.evaluate(sample());
  assert.equal(client.getUsage().estimatedUsd, 0.00003);
  assert.equal(ledger.today().estimatedUsd, 0.00003);
});

test("a missing, malformed, or BYOK cost keeps the estimate and never fails the response", async () => {
  const cases: Array<[string, Record<string, unknown> | string]> = [
    ["missing", {}],
    ["null", { cost: null }],
    ["a string", { cost: "0.00003" }],
    ["negative", { cost: -0.00003 }],
    ["infinite", '"cost":1e400'],
    ["an object", { cost: { usd: 0.00003 } }],
    // On BYOK, `cost` is OpenRouter's fee alone; the upstream provider bills the rest, so it is no request cost.
    ["a BYOK fee", { cost: 0.00003, is_byok: true }],
  ];
  for (const [label, extra] of cases) {
    const ledger = openUsageLedger({ path: ledgerPath() });
    const client = createTypeSafe({ apiKey, backend: "openrouter", ledger, fetch: async () => reply(1_000_000, extra) });
    const result = await client.evaluate(sample());
    assert.equal(result.answers.yes.noul, 0.98, label);
    assert.equal(client.getUsage().estimatedUsd, DEFAULT_USD_PER_MTOK, label);
    assert.equal(ledger.today().estimatedUsd, DEFAULT_USD_PER_MTOK, label);
  }
  // A cost reported without BYOK, or with BYOK explicitly off, is recorded.
  const ledger = openUsageLedger({ path: ledgerPath() });
  const client = createTypeSafe({ apiKey, backend: "openrouter", ledger, fetch: async () => reply(1_000_000, { cost: 0.00003, is_byok: false }) });
  await client.evaluate(sample());
  assert.equal(client.getUsage().estimatedUsd, 0.00003);
});

test("a backend that does not report what it billed is estimated even when its response carries a cost", async () => {
  const gateway: BackendEndpoint = { label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" };
  for (const backend of ["typesafe", "commandcode", gateway] as const) {
    const ledger = openUsageLedger({ path: ledgerPath() });
    const client = createTypeSafe({ apiKey, backend, ledger, fetch: async () => reply(1_000_000, { cost: 5 }) });
    await client.evaluate(sample());
    assert.equal(client.getUsage().estimatedUsd, DEFAULT_USD_PER_MTOK);
    assert.equal(ledger.today().estimatedUsd, DEFAULT_USD_PER_MTOK);
  }
});
