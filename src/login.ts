import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTypeSafe } from "./client.js";
import { keySituation, normalizeApiKey, storeApiKey } from "./credentials.js";
import type { KeySource } from "./credentials.js";
import { TypeSafeIntegrationError } from "./errors.js";
import { promptForApiKey } from "./key-prompt.js";

export interface LoginResult {
  /** Where the verified key was saved. */
  path: string;
  /** Number of models the key can access; proves the key was accepted by the API. */
  models: number;
}

/**
 * Prompt for a key (hidden input), verify it with a model listing, and store it for every pi-typesafe consumer.
 * Resolves to undefined when the user cancels. Rejects with TypeSafeIntegrationError for an invalid or unverifiable key.
 * Refuses when TYPESAFE_API_KEY is set, because the environment would shadow the stored key.
 */
export async function loginWithPrompt(ctx: ExtensionCommandContext): Promise<LoginResult | undefined> {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    throw new TypeSafeIntegrationError("configuration", "TYPESAFE_API_KEY is set in the environment and takes precedence over a stored key. Unset it before logging in interactively.");
  }
  if (!ctx.hasUI) {
    throw new TypeSafeIntegrationError("configuration", "Logging in needs an interactive session. Set TYPESAFE_API_KEY in the environment instead.");
  }
  const entered = await promptForApiKey(ctx);
  if (entered === undefined) return undefined;
  const key = normalizeApiKey(entered);
  // Verify before saving so a bad paste fails here, not on first use.
  const models = await createTypeSafe({ apiKey: key }).listModels();
  return { path: storeApiKey(key), models: models.length };
}

export type EnsureApiKeyResult =
  | { source: KeySource; login?: undefined }
  | { source: "stored"; login: LoginResult };

/**
 * Use the configured key if there is one; otherwise run the login prompt. `undefined` means the user cancelled.
 * A store that must not be read throws `configuration` with the reason instead of prompting, so a permissions
 * problem stays visible; the result shape is frozen for existing callers.
 */
export async function ensureApiKey(ctx: ExtensionCommandContext): Promise<EnsureApiKeyResult | undefined> {
  const situation = keySituation();
  if (situation.kind === "environment" || situation.kind === "stored") return { source: situation.kind };
  if (situation.kind === "unusable") throw new TypeSafeIntegrationError("configuration", situation.reason);
  const login = await loginWithPrompt(ctx);
  return login ? { source: "stored", login } : undefined;
}
