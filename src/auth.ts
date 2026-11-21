import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_BACKEND, resolveBackend } from "./backends.js";
import type { BackendEndpoint, BackendSpec } from "./backends.js";
import { credentialId, credentialsPath, keySituation, keySourceLabel, piTypesafeDir } from "./credentials.js";
import type { KeySituation, KeySource } from "./credentials.js";
import { TypeSafeIntegrationError } from "./errors.js";
import type { IntegrationErrorCode } from "./errors.js";

const AUTH_VERSION = 1;
const CODES: ReadonlySet<string> = new Set<IntegrationErrorCode>([
  "configuration", "validation", "budget", "aborted", "timeout", "http", "connection", "response",
]);

function assertNever(value: never): never {
  throw new Error(`Unexpected auth state: ${String(value)}`);
}

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

/** Explicit auth breaker state for one backend. */
export type AuthStatus =
  | "missing"
  | "unusable"
  | "rejected"
  | "rejection_expired"
  | "unverified"
  | "verified";

/** Persisted per-backend auth record written through `transitionAuthRecord`. */
export interface AuthRecord {
  readonly verifiedAt?: string;
  readonly lastFailure?: AuthFailure;
}

export type AuthEvent =
  | { readonly type: "verified"; readonly at: string }
  | { readonly type: "failed"; readonly failure: AuthFailure }
  | { readonly type: "cleared" };

export interface AuthWriteOptions {
  readonly backend?: BackendSpec;
  readonly path?: string;
}

/** Single-writer pure transition reducer for one backend's persisted auth record. */
export function transitionAuthRecord(record: AuthRecord, event: AuthEvent): AuthRecord {
  switch (event.type) {
    case "verified":
      return { verifiedAt: event.at };
    case "failed":
      return {
        ...(record.verifiedAt === undefined ? {} : { verifiedAt: record.verifiedAt }),
        lastFailure: event.failure,
      };
    case "cleared":
      return {};
    default:
      return assertNever(event);
  }
}

type Rejection = "none" | "fresh" | "expired";

/** `fresh` still vetoes the key, `expired` is only a record of what was refused when: no schema change, no manual reset. */
function rejectionOf(failure: AuthFailure | undefined, nowMs: number): Rejection {
  if (failure === undefined || failure.code !== "http" || !isKeyRejection(failure.status)) return "none";
  const at = Date.parse(failure.at);
  // A timestamp this code cannot read cannot prove the rejection is current, so it counts as spent.
  if (!Number.isFinite(at)) return "expired";
  return nowMs - at < AUTH_REJECTION_TTL_MS ? "fresh" : "expired";
}

function evaluateAuth(
  situation: KeySituation,
  record: AuthRecord,
  nowMs: number,
): { readonly status: AuthStatus; readonly usable: boolean; readonly verified: boolean } {
  const rejection = rejectionOf(record.lastFailure, nowMs);
  const status: AuthStatus =
    situation.kind === "missing" ? "missing"
      : situation.kind === "unusable" ? "unusable"
        : rejection === "fresh" ? "rejected"
          : rejection === "expired" ? "rejection_expired"
            : record.verifiedAt === undefined ? "unverified"
              : "verified";
  const usable = status !== "missing" && status !== "unusable" && status !== "rejected";
  // Keeps `verified` aligned with `verifiedAt` whenever no fresh 401 stands against it (including expired 401s).
  const verified = record.verifiedAt !== undefined && rejection !== "fresh";
  return { status, usable, verified };
}

/**
 * The whole answer to "is Jev actually available right now": which key is in effect, whether it has been accepted, and
 * the last failure that degraded it. Consumers must consult this instead of treating their own consent flag as proof
 * that judgments will happen — an enabled extension with no key used to look identical to a working one.
 */
export interface AuthState {
  /** The judgment backend this state describes; each backend has its own key. Holds the value the caller passed. */
  readonly backend: BackendSpec;
  /** Explicit auth breaker state derived from key presence, persisted record, and the rejection window. */
  readonly status: AuthStatus;
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
   * request proves any key). A 401 rejection younger than `AUTH_REJECTION_TTL_MS` clears it; a 403 never does. Each
   * backend keeps its own record in `auth-state.json`.
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

function parseRecord(raw: unknown): AuthRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as { verifiedAt?: unknown; lastFailure?: unknown };
  const verifiedAt = typeof obj.verifiedAt === "string" && obj.verifiedAt.length <= 40 ? obj.verifiedAt : undefined;
  const failure = obj.lastFailure && typeof obj.lastFailure === "object" && !Array.isArray(obj.lastFailure)
    ? obj.lastFailure as Record<string, unknown>
    : undefined;
  const code = typeof failure?.code === "string" && CODES.has(failure.code) ? failure.code as IntegrationErrorCode : undefined;
  const message = typeof failure?.message === "string" ? failure.message.slice(0, 300) : undefined;
  const at = typeof failure?.at === "string" && failure.at.length <= 40 ? failure.at : undefined;
  const status = typeof failure?.status === "number" && Number.isSafeInteger(failure.status) ? failure.status : undefined;
  const lastFailure = code && message && at
    ? { code, message, at, ...(status === undefined ? {} : { status }) }
    : undefined;
  return { ...(verifiedAt === undefined ? {} : { verifiedAt }), ...(lastFailure === undefined ? {} : { lastFailure }) };
}

function isNonEmptyRecord(record: AuthRecord): boolean {
  return record.verifiedAt !== undefined || record.lastFailure !== undefined;
}

function readStateMap(path: string): Record<string, AuthRecord> {
  const map: Record<string, AuthRecord> = Object.create(null) as Record<string, AuthRecord>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    const raw = parsed as { backends?: unknown; verifiedAt?: unknown; lastFailure?: unknown };
    if (raw.backends && typeof raw.backends === "object" && !Array.isArray(raw.backends)) {
      for (const [id, entry] of Object.entries(raw.backends as Record<string, unknown>)) {
        const record = parseRecord(entry);
        if (isNonEmptyRecord(record)) map[id] = record;
      }
    }
    // Pre-per-backend files hold top-level verifiedAt/lastFailure; heal them into DEFAULT_BACKEND on read.
    if (!(DEFAULT_BACKEND in map)) {
      const legacy = parseRecord(raw);
      if (isNonEmptyRecord(legacy)) map[DEFAULT_BACKEND] = legacy;
    }
    return map;
  } catch {
    return map;
  }
}

/** Owner-only, atomic, and best-effort: an unwritable auth record never changes how a request behaves. */
function writeStateMap(path: string, backends: Record<string, AuthRecord>): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify({ version: AUTH_VERSION, backends: { ...backends } }, null, 2)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup only */ }
  }
}

function isBackendEndpoint(value: object): value is BackendEndpoint {
  return "host" in value || "label" in value || "keyEnv" in value;
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
  const stored = readStateMap(path)[credentialId(backend)] ?? {};
  const source: KeySource | undefined = situation.kind === "environment" ? "environment" : situation.kind === "stored" ? "stored" : undefined;
  const { status, usable, verified } = evaluateAuth(situation, stored, Date.now());
  return {
    backend,
    status,
    kind: situation.kind,
    ...(source === undefined ? {} : { source }),
    path: situation.kind === "unusable" ? situation.path : credentialsPath(),
    ...(situation.kind === "unusable" ? { reason: situation.reason } : {}),
    keyName: keySourceLabel(situation),
    verified,
    ...(stored.verifiedAt === undefined ? {} : { verifiedAt: stored.verifiedAt }),
    ...(stored.lastFailure === undefined ? {} : { lastFailure: stored.lastFailure }),
    usable,
  };
}

/** Record that the key was accepted: login verification, or any successful request. Clears the last failure. */
export function recordAuthVerified(at: Date = new Date(), options: AuthWriteOptions = {}): void {
  const path = options.path ?? authStatePath();
  const id = credentialId(options.backend);
  const map = readStateMap(path);
  map[id] = transitionAuthRecord(map[id] ?? {}, { type: "verified", at: at.toISOString() });
  writeStateMap(path, map);
}

/** Record the failure that degraded a backend. The verification timestamp is kept so a recovered key stays known. */
export function recordAuthFailure(error: TypeSafeIntegrationError, at: Date = new Date(), options: AuthWriteOptions = {}): void {
  const path = options.path ?? authStatePath();
  const id = credentialId(options.backend);
  const map = readStateMap(path);
  const failure: AuthFailure = {
    code: error.code,
    message: error.message,
    at: at.toISOString(),
    ...(error.status === undefined ? {} : { status: error.status }),
  };
  map[id] = transitionAuthRecord(map[id] ?? {}, { type: "failed", failure });
  writeStateMap(path, map);
}

/** Forget verification and degradation: removes the whole file with no backend, or clears only that backend's entry. */
export function clearAuthState(options?: BackendSpec | AuthWriteOptions): void {
  let backend: BackendSpec | undefined;
  let path = authStatePath();
  if (typeof options === "string") {
    backend = options;
  } else if (options !== undefined) {
    if (isBackendEndpoint(options)) {
      backend = options;
    } else {
      backend = options.backend;
      if (options.path !== undefined) path = options.path;
    }
  }
  if (backend === undefined) {
    try { rmSync(path, { force: true }); } catch { /* nothing to clear */ }
    return;
  }
  const id = credentialId(backend);
  const map = readStateMap(path);
  if (!(id in map)) return;
  const next = transitionAuthRecord(map[id] ?? {}, { type: "cleared" });
  if (!isNonEmptyRecord(next)) delete map[id];
  else map[id] = next;
  if (Object.keys(map).length === 0) {
    try { rmSync(path, { force: true }); } catch { /* nothing to clear */ }
  } else {
    writeStateMap(path, map);
  }
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
  switch (state.status) {
    case "missing": {
      const how = `a key is configured (/typesafe login${config.name && config.name !== DEFAULT_BACKEND ? ` ${config.name}` : ""} or ${config.keyEnv})`;
      return { level: "error", text: `${label}: missing — every Jev judgment will fail until ${how}.${since}` };
    }
    case "unusable":
      return { level: "error", text: `${label}: unusable (${state.reason ?? "unknown reason"}) — judgments will fail until the key is fixed.${since}` };
    case "rejected":
      return { level: "error", text: `${label}: ${state.keyName} was rejected.${since}` };
    case "rejection_expired": {
      const at = state.lastFailure?.at;
      return { level: "warning", text: `${label}: ${state.keyName} was rejected${at === undefined ? "" : ` at ${at}`}; that rejection expired, so the next request proves the key.` };
    }
    case "unverified":
      return { level: "warning", text: `${label}: ${state.keyName} (not verified yet — the first request proves it).${since}` };
    case "verified":
      return { level: "ok", text: `${label}: ${state.keyName} (verified${state.verifiedAt ? ` ${state.verifiedAt}` : ""}).${since}` };
    default:
      return assertNever(state.status);
  }
}
