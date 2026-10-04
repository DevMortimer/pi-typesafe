import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_USD_PER_MTOK, LOCK_STALE_MS, LOCK_WAIT_MS, capsFromEnvironment, estimateUsd, localDay, mergeCaps, openUsageLedger, usagePath,
} from "../src/usage.js";

const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-usage-"));
const ledgerPath = (name: string) => join(workspace, `${name}.json`);
const at = (day: number, hour = 12) => new Date(2026, 0, day, hour);

test("a ledger counts requests, tokens, and failures, and prices input tokens only", () => {
  const ledger = openUsageLedger({ path: ledgerPath("counts"), now: at.bind(null, 1) });
  assert.deepEqual(ledger.today(), { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0, day: "2026-01-01", estimatedUsd: 0 });
  ledger.recordStart();
  ledger.recordSuccess(42, 7);
  ledger.recordStart();
  ledger.recordFailure();
  const today = ledger.today();
  assert.deepEqual({ ...today, estimatedUsd: undefined }, { requestsStarted: 2, requestsSucceeded: 1, requestsFailed: 1, inputTokens: 42, outputTokens: 7, day: "2026-01-01", estimatedUsd: undefined });
  // Output tokens are free; only input tokens carry a price.
  assert.equal(today.estimatedUsd, estimateUsd(42, DEFAULT_USD_PER_MTOK));
  assert.ok(ledger.describe().includes("2 requests today (1 ok, 1 failed)"));
  assert.ok(ledger.describe().includes("~$0.0000"));
});

test("totals survive a new ledger instance, so a restart does not reset the day", () => {
  const path = ledgerPath("persist");
  const first = openUsageLedger({ path, now: at.bind(null, 2) });
  first.recordStart();
  first.recordSuccess(1_000, 0);
  const second = openUsageLedger({ path, now: at.bind(null, 2) });
  assert.equal(second.today().requestsStarted, 1);
  assert.equal(second.today().inputTokens, 1_000);
  assert.equal(second.today().estimatedUsd, estimateUsd(1_000, DEFAULT_USD_PER_MTOK));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("the day rolls over on the local date and old days are kept", () => {
  let day = 3;
  const path = ledgerPath("rollover");
  const ledger = openUsageLedger({ path, now: () => at(day) });
  ledger.recordStart();
  ledger.recordSuccess(500, 0);
  day = 4;
  assert.equal(ledger.today().day, "2026-01-04");
  assert.equal(ledger.today().requestsStarted, 0);
  assert.equal(ledger.today().inputTokens, 0);
  ledger.recordStart();
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.days["2026-01-03"].inputTokens, 500);
  assert.equal(file.days["2026-01-04"].requestsStarted, 1);
});

test("each cap stops the next request and names itself", () => {
  const counting = openUsageLedger({ path: ledgerPath("cap-requests"), now: at.bind(null, 5) });
  const requests = { maxRequestsPerDay: 1 };
  assert.equal(counting.blocked(requests), undefined);
  counting.recordStart();
  assert.deepEqual(counting.blocked(requests), { cap: "requestsPerDay", limit: 1, used: 1, day: "2026-01-05" });

  const tokens = openUsageLedger({ path: ledgerPath("cap-tokens"), now: at.bind(null, 5) });
  const tokenCap = { maxInputTokensPerDay: 100 };
  tokens.recordSuccess(100, 0);
  assert.equal(tokens.blocked(tokenCap)?.cap, "inputTokensPerDay");

  const usd = openUsageLedger({ path: ledgerPath("cap-usd"), now: at.bind(null, 5), usdPerMTok: 1_000_000 });
  const usdCap = { maxUsdPerDay: 0.5 };
  usd.recordSuccess(1, 0);
  assert.equal(usd.blocked(usdCap)?.cap, "usdPerDay");
  assert.equal(usd.blocked(usdCap)?.used, 1);
  // The caps belong to the caller: the same totals block under one cap and pass under another.
  assert.equal(usd.blocked({ maxUsdPerDay: 10 }), undefined);
});

test("caps come from the environment without ever raising the explicit cap", () => {
  const environment = capsFromEnvironment({ PI_TYPESAFE_MAX_REQUESTS_PER_DAY: "500", PI_TYPESAFE_MAX_USD_PER_DAY: "2.5", PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY: "nonsense" });
  assert.deepEqual(environment, { maxRequestsPerDay: 500, maxUsdPerDay: 2.5 });
  assert.deepEqual(mergeCaps({ maxRequests: 20, maxUsdPerDay: 1 }, environment), { maxRequests: 20, maxRequestsPerDay: 500, maxUsdPerDay: 1 });
  assert.deepEqual(mergeCaps({}, {}), {});
  assert.deepEqual(capsFromEnvironment({}), {});
});

test("a corrupt, unreadable, or foreign ledger never blocks a request", () => {
  const path = ledgerPath("corrupt");
  writeFileSync(path, "{ not json");
  const ledger = openUsageLedger({ path, now: at.bind(null, 6) });
  assert.equal(ledger.today().requestsStarted, 0);
  ledger.recordStart();
  assert.equal(openUsageLedger({ path, now: at.bind(null, 6) }).today().requestsStarted, 1);
  writeFileSync(path, JSON.stringify({ version: 1, days: { "2026-01-06": { requestsStarted: "many" }, notADay: {} } }));
  assert.equal(openUsageLedger({ path, now: at.bind(null, 6) }).today().requestsStarted, 0);
});

test("the default usage path sits with the key store", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = workspace;
  try {
    assert.equal(usagePath(), join(workspace, "pi-typesafe", "usage.json"));
    assert.equal(localDay(at(7)), "2026-01-07");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

const writer = join(import.meta.dirname, "helpers", "usage-writer.ts");

/** Run one writer process to completion; they all start at `startAt`. */
const runWriter = (path: string, iterations: number, startAt: number, usd: number) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", writer, path, String(iterations), String(startAt), String(usd)], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`))));
  });

test("processes writing one ledger at the same time lose no count", async () => {
  const path = ledgerPath("concurrent");
  const processes = 4;
  const iterations = 200; // Each iteration records a start and a success: 2 updates, so 1,600 updates in all.
  const startAt = Date.now() + 1_500;
  await Promise.all(Array.from({ length: processes }, () => runWriter(path, iterations, startAt, 0.000125)));
  const today = openUsageLedger({ path }).today();
  const total = processes * iterations;
  assert.equal(today.requestsStarted, total);
  assert.equal(today.requestsSucceeded, total);
  assert.equal(today.inputTokens, total * 10);
  assert.equal(today.outputTokens, total * 3);
  assert.ok(Math.abs(today.estimatedUsd - total * 0.000125) < 1e-9, `costUsd ${today.estimatedUsd}`);
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.version, 1);
  assert.equal(file.days[localDay()].costedInputTokens, total * 10);
  assert.ok(Math.abs(file.days[localDay()].costUsd - total * 0.000125) < 1e-9);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("a cap sees the usage another process recorded", async () => {
  const path = ledgerPath("cross-process-cap");
  const ledger = openUsageLedger({ path });
  assert.equal(ledger.blocked({ maxRequestsPerDay: 3 }), undefined);
  await runWriter(path, 3, 0, 0.0001);
  // The ledger was opened before the other process wrote: it still reads the file, not a copy.
  assert.equal(ledger.today().requestsStarted, 3);
  assert.equal(ledger.blocked({ maxRequestsPerDay: 3 })?.cap, "requestsPerDay");
  assert.equal(ledger.blocked({ maxInputTokensPerDay: 30 })?.cap, "inputTokensPerDay");
  assert.equal(ledger.blocked({ maxUsdPerDay: 0.0003 })?.cap, "usdPerDay");
  // This process adds to what the other one wrote instead of replacing it.
  ledger.recordStart();
  assert.equal(openUsageLedger({ path }).today().requestsStarted, 4);
});

test("a lock left by a dead process is taken over", () => {
  const path = ledgerPath("stale-lock");
  writeFileSync(`${path}.lock`, "");
  const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
  utimesSync(`${path}.lock`, old, old);
  const ledger = openUsageLedger({ path });
  const started = Date.now();
  ledger.recordStart();
  assert.ok(Date.now() - started < LOCK_WAIT_MS, "a stale lock must not delay the update");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).days[localDay()].requestsStarted, 1);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("a held lock delays an update at most the bound, and the delta is added later", () => {
  const path = ledgerPath("held-lock");
  writeFileSync(`${path}.lock`, "");
  const ledger = openUsageLedger({ path });
  const started = Date.now();
  ledger.recordStart();
  const waited = Date.now() - started;
  assert.ok(waited >= LOCK_WAIT_MS - 20, `waited ${waited} ms`);
  assert.ok(waited < LOCK_WAIT_MS + 300, `waited ${waited} ms`);
  // The holder's lock is untouched, the file has not been written, and this process still counts the request.
  assert.equal(existsSync(`${path}.lock`), true);
  assert.equal(existsSync(path), false);
  assert.equal(ledger.today().requestsStarted, 1);
  assert.equal(ledger.blocked({ maxRequestsPerDay: 1 })?.cap, "requestsPerDay");
  rmSync(`${path}.lock`);
  ledger.recordSuccess(40, 5, 0.001);
  const day = JSON.parse(readFileSync(path, "utf8")).days[localDay()];
  assert.equal(day.requestsStarted, 1);
  assert.equal(day.requestsSucceeded, 1);
  assert.equal(day.inputTokens, 40);
  assert.equal(day.costUsd, 0.001);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("a held-back delta lands on the day it was recorded", () => {
  let day = 8;
  const path = ledgerPath("held-rollover");
  const ledger = openUsageLedger({ path, now: () => at(day) });
  writeFileSync(`${path}.lock`, "");
  ledger.recordStart();
  rmSync(`${path}.lock`);
  day = 9;
  ledger.recordFailure();
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.days["2026-01-08"].requestsStarted, 1);
  assert.equal(file.days["2026-01-09"].requestsFailed, 1);
  assert.equal(file.days["2026-01-09"].requestsStarted, 0);
});

test("a ledger file written before costs were recorded is still read and extended", () => {
  const path = ledgerPath("old-file");
  writeFileSync(path, JSON.stringify({ version: 1, days: { "2026-01-10": { requestsStarted: 2, requestsSucceeded: 2, requestsFailed: 0, inputTokens: 1_000_000, outputTokens: 5 } } }));
  const ledger = openUsageLedger({ path, now: at.bind(null, 10), usdPerMTok: 1 });
  assert.equal(ledger.today().inputTokens, 1_000_000);
  assert.equal(ledger.today().estimatedUsd, 1);
  ledger.recordStart();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).days["2026-01-10"].costUsd, undefined);
  ledger.recordSuccess(500_000, 0, 0.25);
  const day = JSON.parse(readFileSync(path, "utf8")).days["2026-01-10"];
  assert.equal(day.requestsStarted, 3);
  assert.equal(day.inputTokens, 1_500_000);
  assert.equal(day.costUsd, 0.25);
  assert.equal(day.costedInputTokens, 500_000);
  // 1,000,000 old tokens at the ledger's rate plus the recorded 0.25.
  assert.equal(ledger.today().estimatedUsd, 1.25);
});
