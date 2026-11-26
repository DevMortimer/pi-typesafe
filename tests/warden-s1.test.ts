import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Extension, ExtensionCommandContext, RegisteredCommand, RegisteredTool } from "@earendil-works/pi-coding-agent";
import { APIError, APITimeoutError } from "@typesafe-ai/sdk";
import {
  authState, backendHost, backendPrice, choice, clearAuthState, clearStoredApiKey, createTypeSafe,
  DECISIONS_BACKENDS, describeAuth, deriveWardenS1ModelState, getWardenS1DaemonStatus, getWardenS1Status,
  LOCAL_MAX_INPUT_BYTES, MOCK_WEIGHTS_ENV, noul, resolveBackend, score, sentModelId,
  stopWardenS1Daemon, storeApiKey, TypeSafeIntegrationError, usagePath,
} from "../src/index.js";
import type { TypeSafeBackend } from "../src/index.js";
import { isContextLimitError, safeError } from "../src/errors.js";
import {
  WARDEN_S1_CREDIT, WARDEN_S1_HINT, extensionStatePath, readWardenS1HintState,
  transitionWardenS1Hint,
} from "../src/hint.js";
import type { WardenS1HintState, WardenS1HintTriggerKind } from "../src/hint.js";
import { ensureApiKey, loginWithPrompt } from "../src/login.js";
import { daemonMetadataPath } from "../src/warden-s1-daemon.js";

const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_WARDEN_CACHE_DIR",
  "PI_WARDEN_S1_MOCK_WEIGHTS",
  "PI_TYPESAFE_BACKEND",
  "PI_TYPESAFE_MODEL",
  "PI_TYPESAFE_ENABLED",
  "TYPESAFE_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let agentDir = "";
let cacheDir = "";

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  agentDir = makeTempDir("pi-typesafe-ws1-agent-");
  cacheDir = makeTempDir("pi-typesafe-ws1-cache-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WARDEN_CACHE_DIR = cacheDir;
  globalThis.fetch = originalFetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs) {
    try { await stopWardenS1Daemon(dir, 3000); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface LoadedPi {
  extension: Extension;
  command: RegisteredCommand;
  tool: RegisteredTool;
  notices: Array<{ text: string; level?: string | undefined }>;
  confirms: string[];
  statuses: Array<{ key: string; text: string | undefined }>;
  ctx: ExtensionCommandContext;
  runCommand(args: string, customCtx?: Partial<ExtensionCommandContext>): Promise<void>;
  runTool(params?: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
  startSession(): Promise<void>;
}

async function loadExtension(hasUI = true): Promise<LoadedPi> {
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve("src/extension.ts")],
  });
  await loader.reload();
  const loaded = loader.getExtensions().extensions[0];
  assert.ok(loaded, "extension loaded");
  const command = loaded.commands.get("typesafe");
  const tool = loaded.tools.get("typesafe_evaluate");
  assert.ok(command && tool);
  const notices: Array<{ text: string; level?: string | undefined }> = [];
  const confirms: string[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ui = {
    notify: (text: string, level?: string) => { notices.push({ text, level }); },
    confirm: async (title: string, text?: string) => { confirms.push(text ? `${title} ${text}` : title); return true; },
    editor: async () => undefined,
    custom: async () => { throw new Error("unexpected prompt"); },
    input: async () => { throw new Error("unexpected input"); },
    setStatus: (key: string, text: string | undefined) => { statuses.push({ key, text }); },
  };
  const ctx = { hasUI, ui } as unknown as ExtensionCommandContext;
  return {
    extension: loaded,
    command,
    tool,
    notices,
    confirms,
    statuses,
    ctx,
    runCommand: (args: string, customCtx?: Partial<ExtensionCommandContext>) =>
      Reflect.apply(command.handler, command, [args, customCtx ? { ...ctx, ...customCtx } : ctx]) as Promise<void>,
    runTool: (params = { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } }) =>
      Reflect.apply(tool.definition.execute, tool.definition, ["call-1", params, undefined, undefined, ctx]) as Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>,
    startSession: async () => {
      const handlers = loaded.handlers.get("session_start") ?? [];
      for (const handler of handlers) {
        await Reflect.apply(handler, loaded, [{ reason: "startup" }, ctx]);
      }
    },
  };
}

test("WardenS1HintState transition table is closed across every state, backend, and trigger", () => {
  const states: readonly WardenS1HintState[] = ["unshown", "shown"];
  const backends = Object.keys(DECISIONS_BACKENDS) as TypeSafeBackend[];
  const triggers: readonly WardenS1HintTriggerKind[] = [
    "missing_cloud_key",
    "cloud_context_limit",
    "cloud_timeout",
    "other",
  ];
  for (const state of states) {
    for (const backend of backends) {
      for (const kind of triggers) {
        const result = transitionWardenS1Hint(state, { kind, backend });
        const shouldEmit = state === "unshown"
          && backend !== "warden-s1"
          && (kind === "missing_cloud_key" || kind === "cloud_context_limit" || kind === "cloud_timeout");
        assert.equal(result.emit, shouldEmit, `${state} x ${backend} x ${kind}`);
        assert.equal(result.state, shouldEmit || state === "shown" ? "shown" : "unshown");
      }
    }
  }
});

test("WardenS1ModelState derivation table covers every local model state", () => {
  assert.equal(deriveWardenS1ModelState({ ready: true, installed: true, incomplete: false }), "ready");
  assert.equal(deriveWardenS1ModelState({ ready: false, installed: true, incomplete: false, diagnostic: "missing mlx" }), "runtime_missing");
  assert.equal(deriveWardenS1ModelState({ ready: false, installed: false, incomplete: false, diagnostic: "unsupported arch" }), "unsupported");
  assert.equal(deriveWardenS1ModelState({ ready: false, installed: false, incomplete: true }), "incomplete");
  assert.equal(deriveWardenS1ModelState({ ready: false, installed: false, incomplete: false }), "not_downloaded");
});

test("one-time Warden-S1 hint fires at most once across sessions on missing cloud key and never writes auth.json or usage.json", async () => {
  const first = await loadExtension();
  await first.runCommand("status");
  const firstNotice = first.notices.at(-1)?.text ?? "";
  assert.ok(firstNotice.includes(WARDEN_S1_HINT), firstNotice);
  assert.ok(firstNotice.includes(WARDEN_S1_CREDIT), firstNotice);
  assert.equal(firstNotice.includes("  "), false, firstNotice);
  assert.equal(existsSync(extensionStatePath()), true, "persisted state.json");
  assert.equal(readWardenS1HintState(), "shown");
  assert.equal(existsSync(join(agentDir, "pi-typesafe", "auth.json")), false);
  assert.equal(existsSync(usagePath()), false);

  await first.runCommand("status");
  const secondNotice = first.notices.at(-1)?.text ?? "";
  assert.equal(secondNotice.includes(WARDEN_S1_HINT), false, "hint must not repeat in same session");
  assert.ok(secondNotice.includes(WARDEN_S1_CREDIT), "footer stays on status");

  const reloaded = await loadExtension();
  await reloaded.runCommand("status");
  assert.equal((reloaded.notices.at(-1)?.text ?? "").includes(WARDEN_S1_HINT), false, "hint must not repeat after reload");
  await reloaded.runCommand("enable");
  assert.equal((reloaded.notices.at(-1)?.text ?? "").includes(WARDEN_S1_HINT), false);
});

test("one-time hint fires on cloud HTTP 400 >33K-token context error, byte budget error, and timeout, never on 401/402/403/500 or non-context 400", async () => {
  // Verify safeError strips upstream body while preserving the context-limit marker in the WeakSet.
  const ctxErr = safeError(new APIError(400, { error: "Input exceeds maximum context length of 33000 tokens: secret-payload" }, new Headers()), "typesafe");
  assert.equal(isContextLimitError(ctxErr), true);
  assert.equal(ctxErr.message.includes("33000"), false);
  assert.equal(ctxErr.message.includes("secret-payload"), false);

  const plain400 = safeError(new APIError(400, { error: "Invalid question format" }, new Headers()), "typesafe");
  assert.equal(isContextLimitError(plain400), false);

  // Non-triggering cloud errors must never fire the hint.
  process.env.TYPESAFE_API_KEY = "ts_fake_key_0123456789abcdef";
  process.env.PI_TYPESAFE_ENABLED = "1";
  const pi1 = await loadExtension();
  await pi1.startSession();
  for (const status of [400, 401, 402, 403, 500] as const) {
    globalThis.fetch = async () => Response.json({ error: { message: status === 400 ? "Invalid question format" : "error" } }, { status });
    await assert.rejects(pi1.runTool(), new RegExp(`HTTP ${status}`));
  }
  assert.equal(pi1.notices.some(n => n.text.includes(WARDEN_S1_HINT)), false);
  assert.equal(existsSync(extensionStatePath()), false, "non-triggering errors must not mark hint shown");

  // Context-length HTTP 400 triggers the hint once and never repeats.
  globalThis.fetch = async () => Response.json({ error: { message: "Input exceeds maximum context length of 33000 tokens" } }, { status: 400 });
  await assert.rejects(pi1.runTool(), /HTTP 400/);
  assert.equal(pi1.notices.filter(n => n.text.includes(WARDEN_S1_HINT)).length, 1);
  assert.equal(pi1.notices.some(n => n.text.includes("@devmortimer")), false);
  await assert.rejects(pi1.runTool(), /HTTP 400/);
  assert.equal(pi1.notices.filter(n => n.text.includes(WARDEN_S1_HINT)).length, 1);

  // Fresh state: >64 KiB byte-budget error triggers hint once.
  rmSync(extensionStatePath(), { force: true });
  const pi2 = await loadExtension();
  await pi2.startSession();
  await assert.rejects(
    pi2.runTool({ state: "x".repeat(70_000), questions: { q: { type: "noul", instructions: "Large?" } } }),
    /65536-byte/,
  );
  assert.equal(pi2.notices.filter(n => n.text.includes(WARDEN_S1_HINT)).length, 1);

  // Fresh state: timeout triggers hint once.
  assert.equal(safeError(new APITimeoutError(15_000), "typesafe").code, "timeout");
  rmSync(extensionStatePath(), { force: true });
  const pi3 = await loadExtension();
  await pi3.startSession();
  globalThis.fetch = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  await assert.rejects(pi3.runTool(), /timed out/);
  assert.equal(pi3.notices.filter(n => n.text.includes(WARDEN_S1_HINT)).length, 1);
});

test("quiet maker credit appears only on model download/status and status/help footers, never in tool results or session_start", async () => {
  process.env.TYPESAFE_API_KEY = "ts_fake_key_0123456789abcdef";
  process.env.PI_TYPESAFE_ENABLED = "1";
  const pi = await loadExtension();
  await pi.startSession();
  assert.equal(pi.notices.some(n => n.text.includes("@devmortimer")), false, "never in session_start");

  globalThis.fetch = async () => Response.json({
    model: "jev-test",
    answers: { yes: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 0 },
  });
  const toolResult = await pi.runTool();
  const toolJson = JSON.stringify(toolResult);
  assert.equal(toolJson.includes("@devmortimer"), false, "never in execute output");
  assert.equal(toolJson.includes("x.com"), false);

  const callView = Reflect.apply(pi.tool.definition.renderCall!, pi.tool.definition, [{ questions: { yes: {} } }]) as { render(w: number): string[] };
  assert.equal(callView.render(120).join("\n").includes("@devmortimer"), false, "never in renderCall");

  const resView = Reflect.apply(pi.tool.definition.renderResult!, pi.tool.definition, [toolResult, { expanded: true, isPartial: false }, {}]) as { render(w: number): string[] };
  assert.equal(resView.render(120).join("\n").includes("@devmortimer"), false, "never in renderResult");

  await pi.runCommand("status");
  assert.ok((pi.notices.at(-1)?.text ?? "").includes(WARDEN_S1_CREDIT));

  await pi.runCommand("help");
  assert.ok((pi.notices.at(-1)?.text ?? "").includes(WARDEN_S1_CREDIT));
  assert.equal((pi.notices.at(-1)?.text ?? "").includes("  "), false);

  await pi.runCommand("unknown-subcommand");
  assert.ok((pi.notices.at(-1)?.text ?? "").includes(WARDEN_S1_CREDIT));

  await pi.runCommand("model status");
  const modelStatusText = pi.notices.at(-1)?.text ?? "";
  assert.ok(modelStatusText.includes(WARDEN_S1_CREDIT), modelStatusText);
  assert.ok(modelStatusText.includes("Daemon: not running."), modelStatusText);
  assert.equal(modelStatusText.includes("  "), false, modelStatusText);

  await pi.runCommand("model");
  assert.ok((pi.notices.at(-1)?.text ?? "").includes(WARDEN_S1_CREDIT));
});

test("warden-s1 backend requires no API key, normalizes score legends, prices at $0, and admits 2 MiB payloads", async () => {
  const resolved = resolveBackend("warden-s1");
  assert.equal(resolved.local, true);
  assert.equal(backendHost("warden-s1"), "127.0.0.1");
  assert.equal(sentModelId("warden-s1"), "warden-s1-752m");
  assert.equal(backendPrice(resolved, "warden-s1-752m"), 0);
  assert.equal(backendPrice(resolved, "warden-s1-752m-mlx-q4"), 0);
  assert.equal(backendPrice(resolved, "warden-s1-752m-onnx-int4"), 0);
  assert.equal(LOCAL_MAX_INPUT_BYTES, 2_097_152);

  // Even when TYPESAFE_API_KEY is set, authState("warden-s1") ignores it when weights are absent.
  process.env.TYPESAFE_API_KEY = "ts_fake_key_0123456789abcdef";
  const missingAuth = authState({ backend: "warden-s1" });
  assert.equal(missingAuth.usable, false);
  assert.equal(missingAuth.status, "missing");
  assert.equal(missingAuth.verified, false);
  const missingDesc = describeAuth(missingAuth);
  assert.equal(missingDesc.level, "error");
  assert.ok(missingDesc.text.includes("/typesafe model download"), missingDesc.text);
  assert.equal(missingDesc.text.includes("TYPESAFE_API_KEY"), false);

  // Injected fetch works with no API key and normalizes array legend to indexed object.
  delete process.env.TYPESAFE_API_KEY;
  const seenUrls: string[] = [];
  const client = createTypeSafe({
    backend: "warden-s1",
    fetch: async (url) => {
      seenUrls.push(String(url));
      if (String(url).endsWith("/v1/models")) {
        return Response.json({ models: [{ name: "warden-s1-752m-onnx-int4" }] });
      }
      return Response.json({
        model: "warden-s1-752m-onnx-int4",
        answers: {
          q_noul: { type: "noul", noul: 0.88 },
          q_choice: { type: "choice", choice: "billing", confidence: 0.91, probabilities: { billing: 0.91, other: 0.09 } },
          q_score: { type: "score", score: 1.5, confidence: 0.6, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 }, legend: ["low", "mid", "high"] },
        },
        usage: { input_tokens: 18_000, output_tokens: 0 },
      });
    },
  });
  assert.deepEqual(await client.listModels(), ["warden-s1-752m-onnx-int4"]);
  const largeState = "a".repeat(80_000);
  const res = await client.evaluate({
    state: largeState,
    questions: {
      q_noul: noul("Is this large?"),
      q_choice: choice("Category?", { billing: "Billing", other: "Other" }),
      q_score: score("Severity?", ["low", "mid", "high"]),
    },
  });
  assert.deepEqual(seenUrls, ["http://127.0.0.1/v1/models", "http://127.0.0.1/v1/systemone"]);
  assert.deepEqual(res.answers.q_score.legend, { "0": "low", "1": "mid", "2": "high" });
  assert.equal(client.getUsage().estimatedUsd, 0);
  assert.equal(client.getSpend().today.estimatedUsd, 0);
});

test("warden-s1 rejects loginWithPrompt, checks local readiness in ensureApiKey, omits warden-s1 from login/logout completions, and never fires hint", async () => {
  process.env.PI_TYPESAFE_BACKEND = "warden-s1";
  const pi = await loadExtension();

  await assert.rejects(
    loginWithPrompt(pi.ctx, { backend: "warden-s1" }),
    (err: unknown) => err instanceof TypeSafeIntegrationError && err.code === "configuration" && /does not use an API key/i.test(err.message),
  );
  await assert.rejects(
    ensureApiKey(pi.ctx, { backend: "warden-s1" }),
    (err: unknown) => err instanceof TypeSafeIntegrationError && err.code === "configuration" && err.message.includes("/typesafe model download"),
  );
  assert.throws(
    () => storeApiKey("ts_fake_key_0123456789abcdef", "warden-s1"),
    (err: unknown) => err instanceof TypeSafeIntegrationError && err.code === "configuration",
  );
  assert.equal(clearStoredApiKey("warden-s1"), false);

  const loginCompletions = (await pi.command.getArgumentCompletions?.("login ")) ?? [];
  assert.equal(loginCompletions.some(c => c.value.includes("warden-s1")), false);
  const logoutCompletions = (await pi.command.getArgumentCompletions?.("logout ")) ?? [];
  assert.equal(logoutCompletions.some(c => c.value.includes("warden-s1")), false);
  const modelCompletions = (await pi.command.getArgumentCompletions?.("model ")) ?? [];
  assert.deepEqual(modelCompletions.map(c => c.value), ["model status", "model download"]);

  await pi.runCommand("login");
  assert.ok((pi.notices.at(-1)?.text ?? "").includes("does not use an API key"));
  await pi.runCommand("logout");
  assert.ok((pi.notices.at(-1)?.text ?? "").includes("stores no API key"));
  assert.equal(existsSync(join(agentDir, "pi-typesafe", "auth.json")), false);

  await pi.runCommand("status");
  const statusText = pi.notices.at(-1)?.text ?? "";
  assert.ok(statusText.includes("Warden-S1 backend: 127.0.0.1 (local daemon, no API key, $0)."), statusText);
  assert.ok(statusText.includes("stay on 127.0.0.1"), statusText);
  assert.ok(statusText.includes(WARDEN_S1_CREDIT), statusText);
  assert.equal(statusText.includes(WARDEN_S1_HINT), false, "hint must never fire when backend is warden-s1");
  assert.equal(statusText.includes("  "), false, statusText);

  await pi.runCommand("enable");
  assert.ok((pi.notices.at(-1)?.text ?? "").includes("/typesafe model download"));

  // Without weights or daemon, live client.evaluate rejects with configuration naming /typesafe model download without touching usage.json.
  const liveClient = createTypeSafe({ backend: "warden-s1" });
  await assert.rejects(
    liveClient.evaluate({ state: "hello", questions: { q: noul("Hi?") } }),
    (err: unknown) => err instanceof TypeSafeIntegrationError && err.code === "configuration" && err.message.includes("/typesafe model download"),
  );
  assert.equal(existsSync(usagePath()), false, "missing weights must not write usage.json");

  // With mock weights enabled, authState and ensureApiKey report local readiness and /typesafe enable succeeds.
  process.env[MOCK_WEIGHTS_ENV] = "1";
  assert.equal(authState({ backend: "warden-s1" }).usable, true);
  assert.equal(authState({ backend: "warden-s1" }).status, "verified");
  assert.deepEqual(await ensureApiKey(pi.ctx, { backend: "warden-s1" }), { source: "local" });
  await pi.runCommand("enable");
  assert.ok(pi.confirms.at(-1)?.includes("stay on 127.0.0.1"), pi.confirms.at(-1));
  assert.ok(pi.confirms.at(-1)?.includes("$0 spend, no API key, and no external data transmission"), pi.confirms.at(-1));
  assert.ok((pi.notices.at(-1)?.text ?? "").includes("TypeSafe enabled."));
});

test("/typesafe model download reports completion with maker credit when already verified", async () => {
  // Seed a verified ready manifest for the active host runtime so download command completes offline.
  const initial = getWardenS1Status(undefined, { refreshProbe: true });
  mkdirSync(initial.modelDir, { recursive: true });
  const payload = Buffer.from('{"synthetic":true}\n');
  const sha = createHash("sha256").update(payload).digest("hex");
  writeFileSync(join(initial.modelDir, "config.json"), payload);
  writeFileSync(
    join(initial.modelDir, "warden_s1_ready.json"),
    JSON.stringify({
      version: 1,
      runtime: initial.runtime,
      repoId: initial.repoId,
      modelId: initial.modelId,
      downloadedAt: new Date().toISOString(),
      totalBytes: payload.length,
      files: [{ path: "config.json", bytes: payload.length, sha256: sha }],
    }),
  );
  const seeded = getWardenS1Status(undefined, { refreshProbe: true });
  if (seeded.ready) {
    const pi = await loadExtension();
    await pi.runCommand("model download");
    const notice = pi.notices.at(-1)?.text ?? "";
    assert.ok(notice.includes("already downloaded and verified"), notice);
    assert.ok(notice.includes(WARDEN_S1_CREDIT), notice);
    assert.equal(notice.includes("  "), false, notice);
  }
});

test("downloadWardenS1 verifies SHA-256 digests and writes warden_s1_ready.json into shared cache", async () => {
  const { downloadWardenS1 } = await import("../src/index.js");
  const fakeModelBytes = Buffer.from("synthetic-onnx-weights");
  const fakeSha = createHash("sha256").update(fakeModelBytes).digest("hex");
  const manifestJson = JSON.stringify({
    files: [{ path: "model.onnx", bytes: fakeModelBytes.length, sha256: fakeSha }],
  });
  const progressEvents: number[] = [];
  const res = await downloadWardenS1({ runtime: "onnx" }, {
    hfBaseUrl: "https://hf.example.test",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/onnx_manifest.json")) {
        return new Response(manifestJson, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/model.onnx")) {
        return new Response(fakeModelBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
    ensureOrtRuntime: async () => join(agentDir, "pi-warden", "runtime", "node_modules", "onnxruntime-node"),
    onProgress: (p) => { progressEvents.push(p.percent); },
  });
  assert.equal(res.runtime, "onnx");
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0]?.sha256, fakeSha);
  assert.ok(progressEvents.includes(100));
  const statusAfter = getWardenS1Status({ runtime: "onnx" }, { refreshProbe: true });
  assert.equal(statusAfter.ready, true);
  assert.equal(statusAfter.state, "ready");
});

test("downloadWardenS1 rejects a SHA-256 mismatch without marking weights ready", async () => {
  const { downloadWardenS1 } = await import("../src/index.js");
  const badBytes = Buffer.from("corrupted-weights");
  const wrongSha = "0".repeat(64);
  const manifestJson = JSON.stringify({
    files: [{ path: "model.onnx", bytes: badBytes.length, sha256: wrongSha }],
  });
  await assert.rejects(
    downloadWardenS1({ runtime: "onnx" }, {
      hfBaseUrl: "https://hf.example.test",
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/onnx_manifest.json")) {
          return new Response(manifestJson, { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(badBytes, { status: 200 });
      },
      ensureOrtRuntime: async () => join(agentDir, "pi-warden", "runtime", "node_modules", "onnxruntime-node"),
    }),
    /SHA-256 mismatch/,
  );
  const statusAfter = getWardenS1Status({ runtime: "onnx" }, { refreshProbe: true });
  assert.equal(statusAfter.ready, false);
  assert.equal(statusAfter.installed, false);
});

test("mock-weights loopback singleton daemon: cold-start spawn, typed answers, >64 KiB payload, $0 spend, and second client attach", async () => {
  process.env[MOCK_WEIGHTS_ENV] = "1";
  process.env.PI_TYPESAFE_BACKEND = "warden-s1";
  try {
    const client1 = createTypeSafe({ backend: "warden-s1" });
    const models = await client1.listModels();
    assert.ok(models.length >= 1, `expected model list, got ${JSON.stringify(models)}`);

    const largeState = `## summary\n${"Local 128K evaluation context line.\n".repeat(2500)}`;
    assert.ok(Buffer.byteLength(largeState, "utf8") > 65_536, "state exceeds cloud 64 KiB cap");

    const res1 = await client1.evaluate({
      state: largeState,
      questions: {
        urgent: noul("Does this require immediate attention?"),
        category: choice("Which category?", { billing: "Billing", technical: "Technical", other: "Other" }),
        severity: score("How severe is it?", ["Low", "Medium", "High"]),
      },
    });
    assert.equal(res1.answers.urgent.type, "noul");
    assert.ok(res1.answers.urgent.noul >= 0 && res1.answers.urgent.noul <= 1);
    assert.equal(res1.answers.category.type, "choice");
    assert.ok(["billing", "technical", "other"].includes(res1.answers.category.choice));
    assert.equal(res1.answers.severity.type, "score");
    assert.deepEqual(res1.answers.severity.legend, { "0": "Low", "1": "Medium", "2": "High" });
    assert.equal(client1.getUsage().estimatedUsd, 0);
    assert.equal(client1.getSpend().today.estimatedUsd, 0);

    const meta1 = JSON.parse(readFileSync(daemonMetadataPath(cacheDir), "utf8")) as { pid: number; instanceId: string; host: string; port: number };
    assert.equal(meta1.host, "127.0.0.1");
    assert.ok(meta1.pid > 0 && meta1.port > 0);

    // Second client attaches to the same singleton PID without spawning another process.
    const client2 = createTypeSafe({ backend: "warden-s1" });
    const res2 = await client2.evaluate({
      state: "Second client reusing running daemon",
      questions: { ok: noul("Is it ok?") },
    });
    assert.equal(res2.answers.ok.type, "noul");
    const meta2 = JSON.parse(readFileSync(daemonMetadataPath(cacheDir), "utf8")) as { pid: number; instanceId: string };
    assert.equal(meta2.pid, meta1.pid, "second client must reuse singleton daemon PID");
    assert.equal(meta2.instanceId, meta1.instanceId);

    const daemonStatus = await getWardenS1DaemonStatus(cacheDir);
    assert.equal(daemonStatus.running, true);
    assert.equal(daemonStatus.stats?.pid, meta1.pid);
    assert.ok((daemonStatus.stats?.requests_served ?? 0) >= 2);

    // /typesafe model status reports the live singleton daemon and maker credit.
    const pi = await loadExtension();
    await pi.runCommand("model status");
    const statusText = pi.notices.at(-1)?.text ?? "";
    assert.ok(statusText.includes(`Daemon: running (pid ${meta1.pid}`), statusText);
    assert.ok(statusText.includes(WARDEN_S1_CREDIT), statusText);
    assert.equal(statusText.includes("  "), false, statusText);
  } finally {
    clearAuthState("warden-s1");
    await stopWardenS1Daemon(cacheDir, 5000);
  }
});
