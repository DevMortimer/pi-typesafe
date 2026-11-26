import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { noul } from "@typesafe-ai/sdk";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { authState, authStatePath } from "./auth.js";
import { DEFAULT_BACKEND, resolveBackend } from "./backends.js";
import type { BackendSpec, ResolvedBackend } from "./backends.js";
import { createTypeSafe } from "./client.js";
import { keySituation, normalizeApiKey, storeApiKey } from "./credentials.js";
import type { KeySource } from "./credentials.js";
import { TypeSafeIntegrationError } from "./errors.js";
import { promptForApiKey } from "./key-prompt.js";
import { emptyTotals, localDay } from "./usage.js";
import type { UsageLedger } from "./usage.js";

export interface LoginResult {
  /** Where the verified key was saved. */
  path: string;
  /** Models the key can access, when the backend's model list proves the key. Absent when one judge request proved it. */
  models?: number;
}

export type LoginProbeMode = "models_list" | "judge_probe";

export type LoginState =
  | { readonly stage: "precheck"; readonly spec: BackendSpec; readonly config: ResolvedBackend }
  | { readonly stage: "prompting"; readonly spec: BackendSpec; readonly config: ResolvedBackend }
  | { readonly stage: "cancelled" }
  | { readonly stage: "validating"; readonly spec: BackendSpec; readonly config: ResolvedBackend; readonly entered: string }
  | { readonly stage: "probing"; readonly spec: BackendSpec; readonly config: ResolvedBackend; readonly key: string; readonly mode: LoginProbeMode }
  | { readonly stage: "storing"; readonly spec: BackendSpec; readonly config: ResolvedBackend; readonly key: string; readonly models?: number }
  | { readonly stage: "verified"; readonly result: LoginResult }
  | { readonly stage: "failed"; readonly error: unknown };

export type LoginEvent =
  | { readonly type: "precheck_passed" }
  | { readonly type: "prompt_cancelled" }
  | { readonly type: "prompt_submitted"; readonly entered: string }
  | { readonly type: "key_validated"; readonly key: string }
  | { readonly type: "probe_succeeded"; readonly models?: number }
  | { readonly type: "stored"; readonly path: string }
  | { readonly type: "failed"; readonly error: unknown };

/** Single stage transition writer for interactive login; out-of-order moves fail loudly instead of skipping verification. */
export function transitionLogin(state: LoginState, event: LoginEvent): LoginState {
  if (event.type === "failed") {
    if (state.stage === "cancelled" || state.stage === "verified" || state.stage === "failed") {
      throw new Error(`Invalid login transition: ${event.type} from ${state.stage}`);
    }
    return { stage: "failed", error: event.error };
  }
  switch (state.stage) {
    case "precheck":
      if (event.type === "precheck_passed") return { stage: "prompting", spec: state.spec, config: state.config };
      break;
    case "prompting":
      if (event.type === "prompt_cancelled") return { stage: "cancelled" };
      if (event.type === "prompt_submitted") return { stage: "validating", spec: state.spec, config: state.config, entered: event.entered };
      break;
    case "validating":
      if (event.type === "key_validated") {
        return {
          stage: "probing",
          spec: state.spec,
          config: state.config,
          key: event.key,
          mode: state.config.modelsVerifyKey ? "models_list" : "judge_probe",
        };
      }
      break;
    case "probing":
      if (event.type === "probe_succeeded") {
        return {
          stage: "storing",
          spec: state.spec,
          config: state.config,
          key: state.key,
          ...(event.models === undefined ? {} : { models: event.models }),
        };
      }
      break;
    case "storing":
      if (event.type === "stored") {
        const result: LoginResult = state.models === undefined ? { path: event.path } : { path: event.path, models: state.models };
        return { stage: "verified", result };
      }
      break;
    case "cancelled":
    case "verified":
    case "failed":
      break;
  }
  throw new Error(`Invalid login transition: ${event.type} from ${state.stage}`);
}

/** Isolated ledger for login probes so key verification neither mutates usage.json nor trips daily spend caps. */
function createProbeLedger(): UsageLedger {
  return {
    path: "",
    usdPerMTok: 0,
    today: () => ({ ...emptyTotals(), day: localDay(), estimatedUsd: 0 }),
    recordStart: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    blocked: () => undefined,
    describe: () => "login probe",
  };
}

type FileSnapshot =
  | { readonly kind: "present"; readonly content: Buffer }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

function snapshotFile(path: string): FileSnapshot {
  try {
    return { kind: "present", content: readFileSync(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** Restore auth-state.json after a rejected candidate key so a failed login never poisons the active key's record. */
function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (snapshot.kind === "unreadable") return;
  if (snapshot.kind === "absent") {
    try { rmSync(path, { force: true }); } catch { /* best-effort cleanup only */ }
    return;
  }
  const temporary = `${path}.${process.pid}.restore.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, snapshot.content, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup only */ }
  }
}

/**
 * Prompt for one backend's key (hidden input), prove it before saving, and store it for every pi-typesafe consumer.
 * A backend whose model list is public is proved with one judge question instead, because that list accepts any key.
 * Resolves to undefined when the user cancels. Rejects with TypeSafeIntegrationError for an invalid or unverifiable
 * key. Refuses when the backend's environment variable is set, because the environment would shadow the stored key.
 */
export async function loginWithPrompt(ctx: ExtensionCommandContext, options: { backend?: BackendSpec } = {}): Promise<LoginResult | undefined> {
  const spec = options.backend ?? DEFAULT_BACKEND;
  const config = resolveBackend(spec);
  let state: LoginState = { stage: "precheck", spec, config };
  const advance = (event: LoginEvent): LoginState => {
    state = transitionLogin(state, event);
    return state;
  };

  if (config.local) {
    const error = new TypeSafeIntegrationError("configuration", `${config.label} runs locally on 127.0.0.1 and does not use an API key. Run /typesafe model download to install local weights.`);
    advance({ type: "failed", error });
    throw error;
  }
  if (process.env[config.keyEnv]?.trim()) {
    const error = new TypeSafeIntegrationError("configuration", `${config.keyEnv} is set in the environment and takes precedence over a stored key. Unset it before logging in interactively.`);
    advance({ type: "failed", error });
    throw error;
  }
  if (!ctx.hasUI) {
    const error = new TypeSafeIntegrationError("configuration", `Logging in needs an interactive session. Set ${config.keyEnv} in the environment instead.`);
    advance({ type: "failed", error });
    throw error;
  }
  advance({ type: "precheck_passed" });

  let entered: string | undefined;
  try {
    entered = await promptForApiKey(ctx, config.label);
  } catch (error) {
    advance({ type: "failed", error });
    throw error;
  }
  if (entered === undefined) {
    advance({ type: "prompt_cancelled" });
    return undefined;
  }
  advance({ type: "prompt_submitted", entered });

  let key: string;
  try {
    key = normalizeApiKey(entered);
  } catch (error) {
    advance({ type: "failed", error });
    throw error;
  }
  const probing = advance({ type: "key_validated", key });
  if (probing.stage !== "probing") throw new Error(`Unexpected login stage: ${probing.stage}`);

  const authFile = authStatePath();
  const authSnapshot = snapshotFile(authFile);
  try {
    const client = createTypeSafe({
      apiKey: probing.key,
      backend: probing.spec,
      ledger: createProbeLedger(),
    });
    if (probing.mode === "models_list") {
      const models = await client.listModels();
      advance({ type: "probe_succeeded", models: models.length });
    } else {
      // A public model list accepts any key; one judge question proves this one without touching usage.json.
      await client.evaluate({ state: "login", questions: { key: noul("Is this key accepted?") } });
      advance({ type: "probe_succeeded" });
    }
    const storedPath = storeApiKey(probing.key, probing.spec);
    const done = advance({ type: "stored", path: storedPath });
    if (done.stage !== "verified") throw new Error(`Unexpected login stage: ${done.stage}`);
    return done.result;
  } catch (error) {
    restoreFile(authFile, authSnapshot);
    advance({ type: "failed", error });
    throw error;
  }
}

export type EnsureApiKeyResult =
  | { source: KeySource | "local"; login?: undefined }
  | { source: "stored"; login: LoginResult };

/**
 * Use the configured key for the backend if there is one; otherwise run the login prompt. `undefined` means the user
 * cancelled. A store that must not be read throws `configuration` with the reason instead of prompting, so a
 * permissions problem stays visible; the result shape is frozen for existing callers. Every backend has a login store,
 * so the prompt proves the key against the backend it was asked for and saves it under that backend.
 */
export async function ensureApiKey(ctx: ExtensionCommandContext, options: { backend?: BackendSpec } = {}): Promise<EnsureApiKeyResult | undefined> {
  const backend = options.backend ?? DEFAULT_BACKEND;
  const config = resolveBackend(backend);
  if (config.local) {
    const state = authState({ backend });
    if (state.usable) return { source: "local" };
    throw new TypeSafeIntegrationError("configuration", `${config.label} local weights are not installed. Run /typesafe model download first.`);
  }
  const situation = keySituation(backend);
  if (situation.kind === "environment" || situation.kind === "stored") return { source: situation.kind };
  if (situation.kind === "unusable") throw new TypeSafeIntegrationError("configuration", situation.reason);
  const login = await loginWithPrompt(ctx, { backend });
  return login ? { source: "stored", login } : undefined;
}
