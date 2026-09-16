import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TypeSafeIntegrationError } from "./errors.js";

export type KeySource = "environment" | "stored";

/** Mirrors Pi's agent directory rule so the file sits next to Pi's own auth.json. */
export function credentialsPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? (configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-typesafe", "auth.json");
}

/** Accepts the key only when it is a plausible token; never logs or echoes the value. */
export function normalizeApiKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length < 16 || key.length > 512 || /\s/.test(key) || /[^\x21-\x7e]/.test(key)) {
    throw new TypeSafeIntegrationError("validation", "That does not look like a TypeSafe API key. Copy the complete key from console.typesafe.ai and try again; nothing was saved.");
  }
  return key;
}

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

/** Environment first so CI and scripts stay explicit; the stored key is the interactive default. */
export function resolveApiKey(): { key: string; source: KeySource } | undefined {
  const fromEnvironment = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnvironment) return { key: fromEnvironment, source: "environment" };
  const stored = readStoredApiKey();
  return stored ? { key: stored, source: "stored" } : undefined;
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
