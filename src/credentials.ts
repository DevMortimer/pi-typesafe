import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BACKEND, TYPESAFE_KEY_ENV, backendConfig, usesTypesafeKey } from "./backends.js";
import type { TypeSafeBackend } from "./backends.js";
import { TypeSafeIntegrationError } from "./errors.js";

export type KeySource = "environment" | "stored";

/** The complete, never-throwing answer to "which key is in effect". */
export type KeySituation =
  /** `keyEnv` names the variable that was read; absent means `TYPESAFE_API_KEY`. */
  | { readonly kind: "environment"; readonly key: string; readonly keyEnv?: string }
  | { readonly kind: "stored"; readonly key: string; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unusable"; readonly path: string; readonly reason: string };

/** Mirrors Pi's agent directory rule; every pi-typesafe file lives in this one directory. */
export function piTypesafeDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-typesafe");
}

/** Where the key lives, next to Pi's own auth.json. */
export function credentialsPath(): string {
  return join(piTypesafeDir(), "auth.json");
}

/** Accepts the key only when it is a plausible token; never logs or echoes the value. */
export function normalizeApiKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length < 16 || key.length > 512 || /\s/.test(key) || /[^\x21-\x7e]/.test(key)) {
    throw new TypeSafeIntegrationError("validation", "That does not look like a TypeSafe API key. Copy the complete key from console.typesafe.ai and try again; nothing was saved.");
  }
  return key;
}

/**
 * The stored key, or `undefined` when the file is missing, unreadable, or holds no usable value. Throws
 * `configuration` when the file is readable by other users; keySituation() reports that case as `unusable` instead.
 */
export function readStoredApiKey(): string | undefined {
  const path = credentialsPath();
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      // Refuse to use a key other local users can read; the user must fix permissions or log in again.
      throw new TypeSafeIntegrationError("configuration", `Refusing to read ${path}: it is readable by other users. Run chmod 600 on it, or run /typesafe logout and /typesafe login.`);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const key = parsed && typeof parsed === "object" ? (parsed as { apiKey?: unknown }).apiKey : undefined;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch (error) {
    if (error instanceof TypeSafeIntegrationError) throw error;
    return undefined;
  }
}

/**
 * What the environment, the login store, and file permissions add up to right now for one judgment backend. Never
 * throws; the "unusable" kind carries the user-facing reason (a stored key that other local users can read).
 * The TypeSafe backend reads `TYPESAFE_API_KEY`, then the login store. Every other backend reads only its own
 * environment variable, because the store holds a TypeSafe key and a login verifies against api.typesafe.ai.
 */
export function keySituation(backend: TypeSafeBackend = DEFAULT_BACKEND): KeySituation {
  const config = backendConfig(backend);
  const keyEnv = config.keyEnv ?? TYPESAFE_KEY_ENV;
  const fromEnvironment = process.env[keyEnv]?.trim();
  if (fromEnvironment) return { kind: "environment", key: fromEnvironment, keyEnv };
  if (!usesTypesafeKey(config)) return { kind: "missing" };
  const path = credentialsPath();
  try {
    const key = readStoredApiKey();
    return key ? { kind: "stored", key, path } : { kind: "missing" };
  } catch (error) {
    // readStoredApiKey only throws for a store this process must not use; report it instead of failing the caller.
    if (error instanceof TypeSafeIntegrationError && error.code === "configuration") return { kind: "unusable", path, reason: error.message };
    throw error;
  }
}

/** Short phrase naming the source; full sentences stay with the caller. */
export function keySourceLabel(situation: KeySituation): string {
  switch (situation.kind) {
    case "environment": return situation.keyEnv ?? TYPESAFE_KEY_ENV;
    case "stored": return "/typesafe login";
    case "missing": return "no key";
    case "unusable": return "unusable key";
  }
}

/**
 * The pre-0.4.0 key interface, frozen for existing callers: environment first so CI and scripts stay explicit, the
 * stored key as the interactive default, `undefined` when no key is configured, and a `configuration` error when a
 * store must not be read. New code should call keySituation() instead: same precedence, never throws, and the
 * "must not be read" case arrives as `unusable` with the reason.
 */
export function resolveApiKey(backend: TypeSafeBackend = DEFAULT_BACKEND): { key: string; source: KeySource } | undefined {
  const situation = keySituation(backend);
  if (situation.kind === "unusable") throw new TypeSafeIntegrationError("configuration", situation.reason);
  return situation.kind === "environment" || situation.kind === "stored" ? { key: situation.key, source: situation.kind } : undefined;
}

export function storeApiKey(value: unknown): string {
  const key = normalizeApiKey(value);
  const path = credentialsPath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    throw new TypeSafeIntegrationError("configuration", `Could not write ${path}. Check directory permissions, or set TYPESAFE_API_KEY in the environment instead.`);
  }
  return path;
}

export function clearStoredApiKey(): boolean {
  const path = credentialsPath();
  try {
    statSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}
