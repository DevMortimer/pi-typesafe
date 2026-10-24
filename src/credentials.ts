import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BACKEND, TYPESAFE_KEY_ENV, resolveBackend } from "./backends.js";
import type { BackendSpec } from "./backends.js";
import { TypeSafeIntegrationError } from "./errors.js";

export type KeySource = "environment" | "stored";

/**
 * The complete answer to "which key is in effect" for a valid backend: it never throws. An invalid backend — an
 * unknown name or an endpoint object that fails validation — throws the same `configuration` error as resolveBackend.
 */
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

/** Where a stored key belongs: the registry name, or an endpoint's `keyEnv`. Environment variables still win. */
export function credentialId(backend: BackendSpec = DEFAULT_BACKEND): string {
  const config = resolveBackend(backend);
  return config.name ?? config.keyEnv;
}

/** The stored keys, by credential id. The pre-0.12 shape, a lone `apiKey`, reads as the TypeSafe key. */
function readStoredKeys(): Record<string, string> {
  const path = credentialsPath();
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const keys: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    const record = raw as { apiKey?: unknown; keys?: unknown };
    if (record.keys && typeof record.keys === "object" && !Array.isArray(record.keys)) {
      for (const [id, value] of Object.entries(record.keys as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) keys[id] = value.trim();
      }
    }
    if (typeof record.apiKey === "string" && record.apiKey.trim()) keys[DEFAULT_BACKEND] = record.apiKey.trim();
  }
  return keys;
}

/**
 * The stored key for one backend, or `undefined` when the file is missing, unreadable, or holds no usable value. Throws
 * `configuration` when the file is readable by other users; keySituation() reports that case as `unusable` instead.
 */
export function readStoredApiKey(backend: BackendSpec = DEFAULT_BACKEND): string | undefined {
  const path = credentialsPath();
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      // Refuse to use a key other local users can read; the user must fix permissions or log in again.
      throw new TypeSafeIntegrationError("configuration", `Refusing to read ${path}: it is readable by other users. Run chmod 600 on it, or run /typesafe logout and /typesafe login.`);
    }
    return readStoredKeys()[credentialId(backend)];
  } catch (error) {
    if (error instanceof TypeSafeIntegrationError) throw error;
    return undefined;
  }
}

/**
 * What the environment, the login store, and file permissions add up to right now for one judgment backend. A valid
 * backend never throws: the "unusable" kind carries the user-facing reason (a stored key that other local users can
 * read). An invalid backend — an unknown name or an endpoint object that fails validation — throws the same
 * `configuration` error as resolveBackend(), so validate a user-supplied endpoint with resolveBackend() first.
 * One rule for every backend: its own environment variable, then the key stored for it, then missing.
 */
export function keySituation(backend: BackendSpec = DEFAULT_BACKEND): KeySituation {
  const config = resolveBackend(backend);
  const keyEnv = config.keyEnv;
  const fromEnvironment = process.env[keyEnv]?.trim();
  if (fromEnvironment) return { kind: "environment", key: fromEnvironment, keyEnv };
  const path = credentialsPath();
  try {
    const key = readStoredApiKey(backend);
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
 * store must not be read. New code should call keySituation() instead: same precedence, never throws for a valid
 * backend (an invalid one throws resolveBackend's `configuration` error), and the "must not be read" case arrives as
 * `unusable` with the reason.
 */
export function resolveApiKey(backend: BackendSpec = DEFAULT_BACKEND): { key: string; source: KeySource } | undefined {
  const situation = keySituation(backend);
  if (situation.kind === "unusable") throw new TypeSafeIntegrationError("configuration", situation.reason);
  return situation.kind === "environment" || situation.kind === "stored" ? { key: situation.key, source: situation.kind } : undefined;
}

export function storeApiKey(value: unknown, backend: BackendSpec = DEFAULT_BACKEND): string {
  const key = normalizeApiKey(value);
  const path = credentialsPath();
  const id = credentialId(backend);
  // A store that cannot be read (wrong permissions, bad JSON) is replaced rather than blocking the login.
  let keys: Record<string, string> = {};
  try { keys = readStoredKeys(); } catch { keys = {}; }
  keys[id] = key;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Written under a temporary name and renamed, so a crash mid-write cannot truncate the other backends' keys.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    throw new TypeSafeIntegrationError("configuration", `Could not write ${path}. Check directory permissions, or set ${resolveBackend(backend).keyEnv} in the environment instead.`);
  }
  return path;
}

/** Remove one backend's stored key, or with no argument every stored key. Returns true when a key was removed. */
export function clearStoredApiKey(backend?: BackendSpec): boolean {
  const path = credentialsPath();
  try {
    statSync(path);
  } catch {
    return false;
  }
  if (backend === undefined) {
    rmSync(path, { force: true });
    return true;
  }
  let keys: Record<string, string>;
  try { keys = readStoredKeys(); } catch { rmSync(path, { force: true }); return true; }
  const id = credentialId(backend);
  if (!(id in keys)) return false;
  delete keys[id];
  if (!Object.keys(keys).length) rmSync(path, { force: true });
  else {
    // Same temporary-name-then-rename write as storeApiKey: the remaining backends' keys survive a crash.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }
  return true;
}
