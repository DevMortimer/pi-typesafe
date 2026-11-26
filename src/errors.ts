import { APIError, APIConnectionError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import { DECISIONS_BACKENDS, TYPESAFE_KEY_ENV, backendConfig } from "./backends.js";
import type { BackendConfig, BackendSpec } from "./backends.js";

export type IntegrationErrorCode = "configuration" | "validation" | "budget" | "aborted" | "timeout" | "http" | "connection" | "response";

export type ErrorTarget =
  | "configuration"
  | "validation"
  | "credentials"
  | "billing"
  | "permission"
  | "budget"
  | "cancelled"
  | "response";

/** Machine-readable retryability and remediation target so callers and agents never parse error prose. */
export type ErrorDisposition =
  | { readonly status: "transient"; readonly retryable: true; readonly retryAfterSeconds?: number }
  | { readonly status: "permanent"; readonly retryable: false; readonly target: ErrorTarget };

const INTEGRATION_ERROR_CODES: ReadonlySet<string> = new Set<IntegrationErrorCode>([
  "configuration", "validation", "budget", "aborted", "timeout", "http", "connection", "response",
]);
// Side tables keep extra metadata off error and AskAnswer instances so JSON.stringify and deep-equality shapes stay frozen.
const RETRY_AFTER = new WeakMap<TypeSafeIntegrationError, number>();
const ASSOCIATED_DISPOSITION = new WeakMap<object, ErrorDisposition>();
const CONTEXT_LIMIT_ERRORS = new WeakSet<TypeSafeIntegrationError>();

export function markContextLimitError(error: TypeSafeIntegrationError): TypeSafeIntegrationError {
  CONTEXT_LIMIT_ERRORS.add(error);
  return error;
}

export function isContextLimitError(error: unknown): boolean {
  return error instanceof TypeSafeIntegrationError && CONTEXT_LIMIT_ERRORS.has(error);
}

const CONTEXT_LIMIT_RE = /\b(context[_\s-]*(length|window|size|limit)|max(imum)?[_\s-]*(context|input|prompt)?[_\s-]*(length|tokens?)|token[_\s-]*limit|too many tokens|prompt (?:is )?too long|input (?:is )?too long|exceeds?.{0,40}\b(tokens?|context|32\s*k|33\s*k|32768|33000))\b/i;

function isUpstreamContextLimitError(error: APIError): boolean {
  if (error.status !== 400) return false;
  let text = typeof error.message === "string" ? error.message.slice(0, 4000) : "";
  if (typeof error.body === "string") {
    text += ` ${error.body.slice(0, 4000)}`;
  } else if (error.body !== null && typeof error.body === "object") {
    try { text += ` ${JSON.stringify(error.body).slice(0, 4000)}`; } catch { /* ignore unserializable */ }
  }
  return CONTEXT_LIMIT_RE.test(text);
}

/**
 * Safe to display: never contains upstream bodies, keys, or submitted state. The only header value a message can
 * quote is a numeric Retry-After count in seconds, which cannot carry a secret.
 */
export class TypeSafeIntegrationError extends Error {
  override readonly name = "TypeSafeIntegrationError";
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
  get disposition(): ErrorDisposition {
    return classifyError(this);
  }
  get retryable(): boolean {
    return this.disposition.retryable;
  }
}

/** Attach a known disposition to a non-throwing envelope (such as a failed AskAnswer) without adding properties to it. */
export function attachErrorDisposition(envelope: object, disposition: ErrorDisposition): void {
  ASSOCIATED_DISPOSITION.set(envelope, disposition);
}

/** A numeric Retry-After delay in seconds; dates, blanks, and anything else stay out of the message. */
function retryAfterSeconds(error: APIError): number | undefined {
  const raw = error.headers?.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function parseRetryAfterFromMessage(message: string): number | undefined {
  const match = /\bRetry after (\d+) seconds\./.exec(message);
  if (!match?.[1]) return undefined;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function parseHttpStatusFromMessage(message: string): number | undefined {
  const match = /\bHTTP (\d{3})\b/.exec(message);
  if (!match?.[1]) return undefined;
  const status = Number(match[1]);
  return Number.isSafeInteger(status) ? status : undefined;
}

function classifyCode(code: IntegrationErrorCode, status?: number, retryAfter?: number): ErrorDisposition {
  switch (code) {
    case "timeout":
    case "connection":
      return { status: "transient", retryable: true };
    case "configuration":
      return { status: "permanent", retryable: false, target: "configuration" };
    case "validation":
      return { status: "permanent", retryable: false, target: "validation" };
    case "budget":
      return { status: "permanent", retryable: false, target: "budget" };
    case "aborted":
      return { status: "permanent", retryable: false, target: "cancelled" };
    case "response":
      return { status: "permanent", retryable: false, target: "response" };
    case "http": {
      if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
        return {
          status: "transient",
          retryable: true,
          ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
        };
      }
      if (status === 401) return { status: "permanent", retryable: false, target: "credentials" };
      if (status === 402) return { status: "permanent", retryable: false, target: "billing" };
      if (status === 403) return { status: "permanent", retryable: false, target: "permission" };
      if (status === 400 || status === 404 || status === 422) return { status: "permanent", retryable: false, target: "validation" };
      return { status: "permanent", retryable: false, target: "response" };
    }
  }
}

/**
 * Pure retryability classifier for `TypeSafeIntegrationError`, SDK errors, failed `AskAnswer` envelopes, or unknown
 * throwables. Advises callers whether their own workflow may retry (`transient`) or must address a fixed target (`permanent`).
 */
export function classifyError(error: unknown): ErrorDisposition {
  if (error instanceof TypeSafeIntegrationError) {
    const retry = RETRY_AFTER.get(error) ?? parseRetryAfterFromMessage(error.message);
    return classifyCode(error.code, error.status, retry);
  }
  if (error instanceof APIUserAbortError) return classifyCode("aborted");
  if (error instanceof APITimeoutError) return classifyCode("timeout");
  if (error instanceof APIConnectionError) return classifyCode("connection");
  if (error instanceof APIError) return classifyCode("http", error.status, retryAfterSeconds(error));
  if (error !== null && typeof error === "object") {
    const associated = ASSOCIATED_DISPOSITION.get(error);
    if (associated !== undefined) return associated;
    const raw = error as { ok?: unknown; error?: unknown; errorCode?: unknown };
    if (raw.ok === false && typeof raw.error === "string") {
      if (typeof raw.errorCode === "string" && INTEGRATION_ERROR_CODES.has(raw.errorCode)) {
        const code = raw.errorCode as IntegrationErrorCode;
        const status = code === "http" ? parseHttpStatusFromMessage(raw.error) : undefined;
        const retry = code === "http" ? parseRetryAfterFromMessage(raw.error) : undefined;
        return classifyCode(code, status, retry);
      }
      return { status: "permanent", retryable: false, target: "response" };
    }
  }
  return { status: "permanent", retryable: false, target: "response" };
}

/**
 * Classify an error into a message safe to display. The subject of every message is the backend that answered — its
 * `label`, or the caller's endpoint label — falling back to TypeSafe when no backend is passed. `backend` also names
 * the key variable the 401 advice tells the user to check and selects the 402 wording.
 */
export function safeError(error: unknown, backend?: BackendSpec | BackendConfig): TypeSafeIntegrationError {
  if (error instanceof TypeSafeIntegrationError) return error;
  // SDK wraps any transport throw in APIConnectionError; preserve local configuration errors thrown by the daemon transport.
  if (error instanceof APIConnectionError && error.cause instanceof TypeSafeIntegrationError) return error.cause;
  const config = backend === undefined ? undefined : typeof backend === "string" ? backendConfig(backend) : backend;
  const subject = config?.label ?? "TypeSafe";
  const local = config?.local === true;
  const keyEnv = config?.keyEnv ?? TYPESAFE_KEY_ENV;
  const openrouter = config !== undefined && config.host === DECISIONS_BACKENDS.openrouter.host;
  if (error instanceof APIUserAbortError) {
    return new TypeSafeIntegrationError("aborted", local ? `${subject} request cancelled.` : `${subject} request cancelled; an already submitted request may still be billed.`);
  }
  if (error instanceof APITimeoutError || (error instanceof APIConnectionError && (error.cause instanceof APITimeoutError || (error.cause instanceof Error && error.cause.name === "TimeoutError")))) {
    return new TypeSafeIntegrationError("timeout", local ? `${subject} request timed out; it was not retried.` : `${subject} request timed out; it was not retried and may still be billed.`);
  }
  if (error instanceof APIError) {
    const headerRetry = retryAfterSeconds(error);
    const retry = error.status === 429 ? headerRetry : undefined;
    const advice = error.status === 401 ? (local ? "Check the local Warden-S1 daemon or restart it." : `Check ${keyEnv}.`)
      : error.status === 402 ? (openrouter ? "Insufficient credits. Add credits at https://openrouter.ai/credits." : "Check your account balance.")
      : error.status === 403 ? "Check your account access and model permissions."
      : error.status === 429 ? `Check your account quota and try again later.${retry === undefined ? "" : ` Retry after ${retry} seconds.`}`
      : error.status === 400 || error.status === 422 ? "Check the question format and model limits."
      : "Try again later or check the service status.";
    const safe = new TypeSafeIntegrationError("http", `${subject} returned HTTP ${error.status}. ${advice} No automatic retry was made.`, error.status);
    if (headerRetry !== undefined) RETRY_AFTER.set(safe, headerRetry);
    if (isUpstreamContextLimitError(error)) CONTEXT_LIMIT_ERRORS.add(safe);
    return safe;
  }
  if (error instanceof APIConnectionError) return new TypeSafeIntegrationError("connection", `Could not complete the ${subject} connection. No automatic retry was made.`);
  return new TypeSafeIntegrationError("response", `${subject} returned an unreadable or unexpected response.`);
}
