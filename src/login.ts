import { noul } from "@typesafe-ai/sdk";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BACKEND, resolveBackend } from "./backends.js";
import type { BackendSpec } from "./backends.js";
import { createTypeSafe } from "./client.js";
import { keySituation, normalizeApiKey, storeApiKey } from "./credentials.js";
import type { KeySource } from "./credentials.js";
import { TypeSafeIntegrationError } from "./errors.js";
import { promptForApiKey } from "./key-prompt.js";

export interface LoginResult {
  /** Where the verified key was saved. */
  path: string;
  /** Models the key can access, when the backend's model list proves the key. Absent when one judge request proved it. */
  models?: number;
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
  if (process.env[config.keyEnv]?.trim()) {
    throw new TypeSafeIntegrationError("configuration", `${config.keyEnv} is set in the environment and takes precedence over a stored key. Unset it before logging in interactively.`);
  }
  if (!ctx.hasUI) {
    throw new TypeSafeIntegrationError("configuration", `Logging in needs an interactive session. Set ${config.keyEnv} in the environment instead.`);
  }
  const entered = await promptForApiKey(ctx, config.label);
  if (entered === undefined) return undefined;
  const key = normalizeApiKey(entered);
  const client = createTypeSafe({ apiKey: key, backend: spec });
  if (config.modelsVerifyKey) {
    const models = await client.listModels();
    return { path: storeApiKey(key, spec), models: models.length };
  }
  // A public model list accepts any key; one judge question proves this one.
  await client.evaluate({ state: "login", questions: { key: noul("Is this key accepted?") } });
  return { path: storeApiKey(key, spec) };
}

export type EnsureApiKeyResult =
  | { source: KeySource; login?: undefined }
  | { source: "stored"; login: LoginResult };

/**
 * Use the configured key for the backend if there is one; otherwise run the login prompt. `undefined` means the user
 * cancelled. A store that must not be read throws `configuration` with the reason instead of prompting, so a
 * permissions problem stays visible; the result shape is frozen for existing callers. Every backend has a login store,
 * so the prompt proves the key against the backend it was asked for and saves it under that backend.
 */
export async function ensureApiKey(ctx: ExtensionCommandContext, options: { backend?: BackendSpec } = {}): Promise<EnsureApiKeyResult | undefined> {
  const backend = options.backend ?? DEFAULT_BACKEND;
  const situation = keySituation(backend);
  if (situation.kind === "environment" || situation.kind === "stored") return { source: situation.kind };
  if (situation.kind === "unusable") throw new TypeSafeIntegrationError("configuration", situation.reason);
  const login = await loginWithPrompt(ctx, { backend });
  return login ? { source: "stored", login } : undefined;
}
