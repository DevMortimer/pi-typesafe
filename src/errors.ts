import { APIError, APIConnectionError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import { DECISIONS_BACKENDS, TYPESAFE_KEY_ENV, backendConfig } from "./backends.js";
import type { BackendConfig, TypeSafeBackend } from "./backends.js";

export type IntegrationErrorCode = "configuration" | "validation" | "budget" | "aborted" | "timeout" | "http" | "connection" | "response";

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
}

/** A numeric Retry-After delay in seconds; dates, blanks, and anything else stay out of the message. */
function retryAfterSeconds(error: APIError): number | undefined {
  const raw = error.headers?.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Classify an error into a message safe to display. `backend` names the key variable the 401 advice tells the user
 * to check and selects the 402 wording; omitting it keeps the one-argument call and assumes the default TypeSafe key.
 */
export function safeError(error: unknown, backend?: TypeSafeBackend | BackendConfig): TypeSafeIntegrationError {
  if (error instanceof TypeSafeIntegrationError) return error;
  if (error instanceof APIUserAbortError) return new TypeSafeIntegrationError("aborted", "TypeSafe request cancelled; an already submitted request may still be billed.");
  if (error instanceof APITimeoutError) return new TypeSafeIntegrationError("timeout", "TypeSafe request timed out; it was not retried and may still be billed.");
  if (error instanceof APIError) {
    const config = backend === undefined ? undefined : typeof backend === "string" ? backendConfig(backend) : backend;
    const keyEnv = config?.keyEnv ?? TYPESAFE_KEY_ENV;
    const openrouter = config !== undefined && config.host === DECISIONS_BACKENDS.openrouter.host;
    const retry = error.status === 429 ? retryAfterSeconds(error) : undefined;
    const advice = error.status === 401 ? `Check ${keyEnv}.`
      : error.status === 402 ? (openrouter ? "Insufficient credits. Add credits at https://openrouter.ai/credits." : "Check your account balance.")
      : error.status === 403 ? "Check your account access and model permissions."
      : error.status === 429 ? `Check your account quota and try again later.${retry === undefined ? "" : ` Retry after ${retry} seconds.`}`
      : error.status === 400 || error.status === 422 ? "Check the question format and model limits."
      : "Try again later or check the service status.";
    return new TypeSafeIntegrationError("http", `TypeSafe returned HTTP ${error.status}. ${advice} No automatic retry was made.`, error.status);
  }
  if (error instanceof APIConnectionError) return new TypeSafeIntegrationError("connection", "Could not complete the TypeSafe connection. No automatic retry was made.");
  return new TypeSafeIntegrationError("response", "TypeSafe returned an unreadable or unexpected response.");
}
