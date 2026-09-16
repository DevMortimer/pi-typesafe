import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTypeSafe } from "./client.js";
import { normalizeApiKey, resolveApiKey, storeApiKey } from "./credentials.js";
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

/** Use the configured key if there is one; otherwise run the login prompt. Undefined means the user cancelled. */
export async function ensureApiKey(ctx: ExtensionCommandContext): Promise<EnsureApiKeyResult | undefined> {
  const existing = resolveApiKey();
  if (existing) return { source: existing.source };
  const login = await loginWithPrompt(ctx);
  return login ? { source: "stored", login } : undefined;
}
