import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsPath, keySituation, keySourceLabel, piTypesafeDir } from "./credentials.js";
import type { KeySource } from "./credentials.js";
import { TypeSafeIntegrationError } from "./errors.js";
import type { IntegrationErrorCode } from "./errors.js";

const AUTH_VERSION = 1;
const CODES: ReadonlySet<string> = new Set<IntegrationErrorCode>([
  "configuration", "validation", "budget", "aborted", "timeout", "http", "connection", "response",
]);
/** Statuses that mean the key itself was refused, not that the service was busy. */
const REJECTED_STATUSES = new Set([401, 403]);

/** The last request that degraded TypeSafe, with no upstream body, header, key, or submitted state. */
export interface AuthFailure {
  readonly code: IntegrationErrorCode;
  readonly status?: number;
  readonly message: string;
  readonly at: string;
}

/**
 * The whole answer to "is Jev actually available right now": which key is in effect, whether it has been accepted, and
 * the last failure that degraded it. Consumers must consult this instead of treating their own consent flag as proof
 * that judgments will happen — an enabled extension with no key used to look identical to a working one.
 */
export interface AuthState {
  /** Same kinds as KeySituation: where the key in effect comes from. */
  readonly kind: "environment" | "stored" | "missing" | "unusable";
  readonly source?: KeySource;
  /** Where the key would be read from. */
  readonly path: string;
  /** Why a stored key cannot be used, when that is the case. */
  readonly reason?: string;
  /** Short human label for the key source: `TYPESAFE_API_KEY`, `/typesafe login`, `no key`, `unusable key`. */
  readonly keyName: string;
  /** True when the key in effect was accepted by api.typesafe.ai (login verifies it; a successful request proves it). */
  readonly verified: boolean;
  readonly verifiedAt?: string;
  /** The last failure, cleared by the next successful request. */
  readonly lastFailure?: AuthFailure;
  /** A key is present and the last authentication outcome was not a rejection. False means judgments are skipped. */
  readonly usable: boolean;
}

/** The auth-state file: one small, owner-only record that outlives the process that wrote it. */
export function authStatePath(): string {
  return join(piTypesafeDir(), "auth-state.json");
}

function readState(path: string): { verifiedAt?: string; lastFailure?: AuthFailure } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const raw = parsed as { verifiedAt?: unknown; lastFailure?: unknown };
    const verifiedAt = typeof raw.verifiedAt === "string" && raw.verifiedAt.length <= 40 ? raw.verifiedAt : undefined;
    const failure = raw.lastFailure && typeof raw.lastFailure === "object" ? raw.lastFailure as Record<string, unknown> : undefined;
    const code = typeof failure?.code === "string" && CODES.has(failure.code) ? failure.code as IntegrationErrorCode : undefined;
    const message = typeof failure?.message === "string" ? failure.message.slice(0, 300) : undefined;
    const at = typeof failure?.at === "string" && failure.at.length <= 40 ? failure.at : undefined;
    const status = typeof failure?.status === "number" && Number.isSafeInteger(failure.status) ? failure.status : undefined;
    const lastFailure = code && message && at
      ? { code, message, at, ...(status === undefined ? {} : { status }) }
      : undefined;
    return { ...(verifiedAt === undefined ? {} : { verifiedAt }), ...(lastFailure === undefined ? {} : { lastFailure }) };
  } catch {
    return {};
  }
}

/** Owner-only, atomic, and best-effort: an unwritable auth record never changes how a request behaves. */
function writeState(path: string, state: { verifiedAt?: string; lastFailure?: AuthFailure }): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(piTypesafeDir(), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify({ version: AUTH_VERSION, ...state }, null, 2)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup only */ }
  }
}

/** What the key situation, the last outcome, and the clock add up to. Never throws. */
export function authState(options: { path?: string } = {}): AuthState {
  const path = options.path ?? authStatePath();
  const situation = keySituation();
  const stored = readState(path);
  const source: KeySource | undefined = situation.kind === "environment" ? "environment" : situation.kind === "stored" ? "stored" : undefined;
  const rejected = stored.lastFailure?.code === "http" && stored.lastFailure.status !== undefined && REJECTED_STATUSES.has(stored.lastFailure.status);
  const usable = source !== undefined && !rejected;
  return {
    kind: situation.kind,
    ...(source === undefined ? {} : { source }),
    path: situation.kind === "unusable" ? situation.path : credentialsPath(),
    ...(situation.kind === "unusable" ? { reason: situation.reason } : {}),
    keyName: keySourceLabel(situation),
    verified: stored.verifiedAt !== undefined && !rejected,
    ...(stored.verifiedAt === undefined ? {} : { verifiedAt: stored.verifiedAt }),
    ...(stored.lastFailure === undefined ? {} : { lastFailure: stored.lastFailure }),
    usable,
  };
}

/** Record that the key was accepted: login verification, or any successful request. Clears the last failure. */
export function recordAuthVerified(at: Date = new Date()): void {
  writeState(authStatePath(), { verifiedAt: at.toISOString() });
}

/** Record the failure that degraded TypeSafe. The verification timestamp is kept so a recovered key stays known. */
export function recordAuthFailure(error: TypeSafeIntegrationError, at: Date = new Date()): void {
  const current = readState(authStatePath());
  const failure: AuthFailure = {
    code: error.code,
    message: error.message,
    at: at.toISOString(),
    ...(error.status === undefined ? {} : { status: error.status }),
  };
  writeState(authStatePath(), { ...(current.verifiedAt === undefined ? {} : { verifiedAt: current.verifiedAt }), lastFailure: failure });
}

/** Forget verification and degradation: used when the key itself changes (login or logout). */
export function clearAuthState(): void {
  try { rmSync(authStatePath(), { force: true }); } catch { /* nothing to clear */ }
}

export interface AuthReport {
  /** `error` when judgments are skipped or were rejected, `warning` when the key is unverified, otherwise `ok`. */
  readonly level: "ok" | "warning" | "error";
  /** One line naming the key source and, when degraded, the reason. Safe to display. */
  readonly text: string;
}

/**
 * One line plus a level, so a status command, a headless log, or a consumer's own status line can call out a degraded
 * state instead of reporting "enabled".
 */
export function describeAuth(state: AuthState = authState()): AuthReport {
  const since = state.lastFailure ? ` Last failure: ${state.lastFailure.message}${state.lastFailure.at ? ` (${state.lastFailure.at})` : ""}` : "";
  if (state.kind === "missing") {
    return { level: "error", text: `TypeSafe key: missing — every Jev judgment is skipped until a key is configured (/typesafe login or TYPESAFE_API_KEY).${since}` };
  }
  if (state.kind === "unusable") {
    return { level: "error", text: `TypeSafe key: unusable (${state.reason ?? "unknown reason"}) — judgments are skipped until the key is fixed.${since}` };
  }
  const rejected = state.lastFailure?.code === "http" && state.lastFailure.status !== undefined && REJECTED_STATUSES.has(state.lastFailure.status);
  if (rejected) {
    return { level: "error", text: `TypeSafe key: ${state.keyName} was rejected.${since}` };
  }
  if (!state.verified) {
    return { level: "warning", text: `TypeSafe key: ${state.keyName} (not verified yet — the first request proves it).${since}` };
  }
  return { level: "ok", text: `TypeSafe key: ${state.keyName} (verified${state.verifiedAt ? ` ${state.verifiedAt}` : ""}).${since}` };
}
