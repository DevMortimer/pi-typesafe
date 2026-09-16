import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Extension, RegisteredCommand, RegisteredTool } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

let temporary: string;
let extension: Extension;
let tool: RegisteredTool;
let command: RegisteredCommand;
const savedKey = process.env.TYPESAFE_API_KEY;
const savedEnabled = process.env.PI_TYPESAFE_ENABLED;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
const notices: string[] = [];
let confirmResult = true;
let confirmations = 0;
let editorText: string | undefined;
let networkCalls = 0;
let modelListCalls = 0;
let customResult: string | undefined;
const ui = {
  notify: (text: string) => { notices.push(text); },
  confirm: async () => { confirmations++; return confirmResult; },
  editor: async () => editorText,
  custom: async () => customResult,
  input: async () => { throw new Error("plain input must not be used when custom UI exists"); },
};
const ctx = { hasUI: true, ui };
const runCommand = (args: string, context = ctx) => Reflect.apply(command.handler, command, [args, context]);
const runTool = (signal?: AbortSignal) => Reflect.apply(tool.definition.execute, tool.definition, [
  "test-call", { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } }, signal, undefined, ctx,
]);

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-typesafe-test-"));
  delete process.env.PI_TYPESAFE_ENABLED;
  process.env.PI_CODING_AGENT_DIR = temporary;
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/v1/models")) {
      modelListCalls++;
      return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }] });
    }
    networkCalls++;
    return Response.json({ model: "jev-test", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 0 } });
  };
  const loader = new DefaultResourceLoader({
    cwd: temporary,
    agentDir: temporary,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve("src/extension.ts")],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], "native Pi loader must accept the extension");
  const loaded = result.extensions[0];
  assert.ok(loaded);
  extension = loaded;
  const registeredTool = extension.tools.get("typesafe_evaluate");
  const registeredCommand = extension.commands.get("typesafe");
  assert.ok(registeredTool);
  assert.ok(registeredCommand);
  tool = registeredTool;
  command = registeredCommand;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedEnabled === undefined) delete process.env.PI_TYPESAFE_ENABLED; else process.env.PI_TYPESAFE_ENABLED = savedEnabled;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("Pi loads a tool, a slash command, and a result renderer without network calls", async () => {
  assert.equal(networkCalls, 0);
  assert.equal(tool.definition.name, "typesafe_evaluate");
  const completions = await command.getArgumentCompletions?.("pla");
  assert.ok(completions?.some(item => item.value === "playground"));
});

test("default-disabled tool cannot submit data", async () => {
  await assert.rejects(runTool(), /disabled/);
  assert.equal(networkCalls, 0);
});

test("setup and status never display the API key", async () => {
  await runCommand("setup");
  await runCommand("status");
  assert.ok(notices.some(text => text.includes("key from TYPESAFE_API_KEY")));
  assert.equal(notices.some(text => text.includes("offline-test-key")), false);
});

test("login refuses to shadow an environment key", async () => {
  await runCommand("login");
  assert.ok(notices.at(-1)?.includes("takes precedence"));
  assert.equal(modelListCalls, 0);
});

test("declining consent keeps the tool disabled", async () => {
  confirmResult = false;
  await runCommand("enable");
  await assert.rejects(runTool(), /disabled/);
  assert.equal(networkCalls, 0);
});

test("explicit consent enables the real registered tool and returns structured results", async () => {
  confirmResult = true;
  await runCommand("enable");
  const result = await runTool();
  assert.equal(result.details.answers.yes.noul, 0.9);
  assert.equal(networkCalls, 1);
  assert.ok(confirmations >= 2);
  const renderer = tool.definition.renderResult;
  assert.ok(renderer);
  const component = Reflect.apply(renderer, tool.definition, [result, { expanded: true, isPartial: false }, {}]);
  for (const width of [40, 80, 120]) {
    const lines: string[] = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.join("\n").includes("P(yes)"));
  }
});

test("disable stops future calls without resetting usage", async () => {
  await runCommand("disable");
  await assert.rejects(runTool(), /disabled/);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("1/20 attempts"));
});

test("invalid playground JSON and cancellation do not submit data", async () => {
  editorText = '{"broken":';
  await runCommand("playground");
  assert.ok(notices.at(-1)?.includes("Invalid JSON"));
  editorText = undefined;
  await runCommand("playground");
  assert.equal(networkCalls, 1);
});

test("playground validates questions before requesting consent", async () => {
  editorText = JSON.stringify({ state: "example", questions: {} });
  const prior = confirmations;
  await runCommand("playground");
  assert.equal(confirmations, prior);
  assert.equal(networkCalls, 1);
  assert.ok(notices.at(-1)?.includes("Invalid evaluation request"));
});

test("test command requires confirmation and does not enable agent calls", async () => {
  confirmResult = false;
  await runCommand("test");
  assert.equal(networkCalls, 1);
  await assert.rejects(runTool(), /disabled/);
});

test("login verifies, stores with owner-only permissions, and never echoes the key", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const storedPath = join(temporary, "pi-typesafe", "auth.json");
  customResult = undefined;
  await runCommand("login");
  assert.ok(notices.at(-1)?.includes("cancelled"));
  assert.equal(existsSync(storedPath), false);
  customResult = "nope";
  await runCommand("login");
  assert.ok(notices.at(-1)?.includes("does not look like"));
  assert.equal(modelListCalls, 0);
  assert.equal(existsSync(storedPath), false);
  customResult = "ts_live_key_0123456789abcdef";
  await runCommand("login");
  assert.equal(modelListCalls, 1);
  assert.ok(notices.at(-1)?.includes("Key verified (1 model available)"));
  assert.equal(notices.some(text => text.includes("ts_live_key")), false);
  assert.equal(statSync(storedPath).mode & 0o777, 0o600);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("key from /typesafe login"));
  await runCommand("setup");
  assert.ok(notices.at(-1)?.includes("configured via /typesafe login"));
  // The stored key powers the real tool after consent.
  confirmResult = true;
  await runCommand("enable");
  await runTool();
  assert.equal(networkCalls, 2);
  await runCommand("logout");
  assert.equal(existsSync(storedPath), false);
  await assert.rejects(runTool(), /disabled/);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("key missing"));
  process.env.TYPESAFE_API_KEY = "offline-test-key";
});

test("new sessions reset opt-in; headless opt-in is explicit", async () => {
  const handlers = extension.handlers.get("session_start");
  assert.ok(handlers?.length);
  for (const handler of handlers) await Reflect.apply(handler, extension, [{ reason: "new" }, ctx]);
  await assert.rejects(runTool(), /disabled/);
  process.env.PI_TYPESAFE_ENABLED = "1";
  for (const handler of handlers) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
  await runTool();
  assert.equal(networkCalls, 3);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("1/20 attempts"));
});
