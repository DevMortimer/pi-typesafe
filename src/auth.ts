import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BACKEND, TYPESAFE_KEY_ENV, resolveBackend } from "./backends.js";
import type { BackendSpec } from "./backends.js";
import { credentialsPath, keySituation, keySourceLabel, piTypesafeDir } from "./credentials.js";
import type { KeySource } from "./credentials.js";
import { TypeSafeIntegrationError } from "./errors.js";
import type { IntegrationErrorCode } from "./errors.js";

const AUTH_VERSION = 1;
const CODES: ReadonlySet<string> = new Set<IntegrationErrorCode>([
  "configuration", "validation", "budget", "aborted", "timeout", "http", "connection", "response",
]);
/**
 * How long a stored 401 vetoes the key. The next request proves the key again once the window passes, so one refusal
 * cannot disable judgments for good. Fifteen minutes is a policy choice, not a measured provider constant.
 */
export const AUTH_REJECTION_TTL_MS = 15 * 60 * 1000;

/**
 * Only HTTP 401 refuses the key itself. A 403 refuses one request — insufficient permissions, a guardrail block, a
 * moderation flag, or a provider cap — so it never vetoes the key. OpenRouter's error page, checked 2026-11-03, gives
 * 401 invalid credentials, 402 insufficient credits, and 403 forbidden.
 */
export function isKeyRejection(status: number | undefined): boolean {
  return status === 401;
}

/** The last request that degraded TypeSafe, with no upstream body, header, key, or submitted state. */
export interface AuthFailure {
  readonly code: IntegrationErrorCode;
  readonly status?: number;
  readonly message: string;
  readonly at: string;
}

type Rejection = "none" | "fresh" | "expired";

/** `fresh` still vetoes the key, `expired` is only a record of what was refused when: no schema change, no manual reset. */
function rejectionOf(failure: AuthFailure | undefined): Rejection {
  if (failure === undefined || failure.code !== "http" || !isKeyRejection(failure.status)) return "none";
  const at = Date.parse(failure.at);
  // A timestamp this code cannot read cannot prove the rejection is current, so it counts as spent.
  if (!Number.isFinite(at)) return "expired";
  return Date.now() - at < AUTH_REJECTION_TTL_MS ? "fresh" : "expired";
}

/**
 * The whole answer to "is Jev actually available right now": which key is in effect, whether it has been accepted, and
 * the last failure that degraded it. Consumers must consult this instead of treating their own consent flag as proof
 * that judgments will happen — an enabled extension with no key used to look identical to a working one.
 */
export interface AuthState {
  /** The judgment backend this state describes; each backend has its own key. Holds the value the caller passed. */
  readonly backend: BackendSpec;
  /** Same kinds as KeySituation: where the key in effect comes from. */
  readonly kind: "environment" | "stored" | "missing" | "unusable";
  readonly source?: KeySource;
  /** Where the key would be read from. */
  readonly path: string;
  /** Why a stored key cannot be used, when that is the case. */
  readonly reason?: string;
  /** Short human label for the key source: `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `/typesafe login`, `no key`, `unusable key`. */
  readonly keyName: string;
  /**
   * True when the key in effect was accepted by the backend (a login proves the backend it was asked for; a successful
   * request proves any key). A 401 rejection younger than `AUTH_REJECTION_TTL_MS` clears it; a 403 never does. The
   * record is shared across backends: switching backends keeps the last outcome until the next request.
   */
  readonly verified: boolean;
  readonly verifiedAt?: string;
  /** The last failure, cleared by the next successful request. */
  readonly lastFailure?: AuthFailure;
  /**
   * A key is present and no 401 rejection younger than `AUTH_REJECTION_TTL_MS` stands against it. A 403 never makes it
   * false, because it refuses one request, not the key. False means judgments will fail.
   */
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

/**
 * What the key situation, the last outcome, and the clock add up to for a valid backend; it never throws for one. An
 * invalid backend throws the same `configuration` error as resolveBackend(), so validate a user-supplied endpoint
 * with resolveBackend() first.
 */
export function authState(options: { path?: string; backend?: BackendSpec } = {}): AuthState {
  const path = options.path ?? authStatePath();
  const backend = options.backend ?? DEFAULT_BACKEND;
  const situation = keySituation(backend);
  const stored = readState(path);
  const source: KeySource | undefined = situation.kind === "environment" ? "environment" : situation.kind === "stored" ? "stored" : undefined;
  const rejected = rejectionOf(stored.lastFailure) === "fresh";
  const usable = source !== undefined && !rejected;
  return {
    backend,
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
  /**
   * `error` when judgments will fail or the key was rejected, `warning` when the key is unverified or its rejection has
   * expired, otherwise `ok`.
   */
  readonly level: "ok" | "warning" | "error";
  /** One line naming the key source and, when degraded, the reason. Safe to display. */
  readonly text: string;
}

/**
 * One line plus a level, so a status command, a headless log, or a consumer's own status line can call out a degraded
 * state instead of reporting "enabled".
 */
export function describeAuth(state: AuthState = authState()): AuthReport {
  const config = resolveBackend(state.backend);
  const label = `${config.label} key`;
  const since = state.lastFailure ? ` Last failure: ${state.lastFailure.message}${state.lastFailure.at ? ` (${state.lastFailure.at})` : ""}` : "";
  if (state.kind === "missing") {
    const how = `a key is configured (/typesafe login${config.name && config.name !== DEFAULT_BACKEND ? ` ${config.name}` : ""} or ${config.keyEnv})`;
    return { level: "error", text: `${label}: missing — every Jev judgment will fail until ${how}.${since}` };
  }
  if (state.kind === "unusable") {
    return { level: "error", text: `${label}: unusable (${state.reason ?? "unknown reason"}) — judgments will fail until the key is fixed.${since}` };
  }
  const rejection = rejectionOf(state.lastFailure);
  if (rejection === "fresh") {
    return { level: "error", text: `${label}: ${state.keyName} was rejected.${since}` };
  }
  if (rejection === "expired") {
    const at = state.lastFailure?.at;
    return { level: "warning", text: `${label}: ${state.keyName} was rejected${at === undefined ? "" : ` at ${at}`}; that rejection expired, so the next request proves the key.` };
  }
  if (!state.verified) {
    return { level: "warning", text: `${label}: ${state.keyName} (not verified yet — the first request proves it).${since}` };
  }
  return { level: "ok", text: `${label}: ${state.keyName} (verified${state.verifiedAt ? ` ${state.verifiedAt}` : ""}).${since}` };
}
