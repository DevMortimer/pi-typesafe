import { APIError, APIConnectionError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";

export type IntegrationErrorCode = "configuration" | "validation" | "budget" | "aborted" | "timeout" | "http" | "connection" | "response";

/** Safe to display: never contains upstream bodies, headers, keys, or submitted state. */
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

export function safeError(error: unknown): TypeSafeIntegrationError {
  if (error instanceof TypeSafeIntegrationError) return error;
  if (error instanceof APIUserAbortError) return new TypeSafeIntegrationError("aborted", "TypeSafe request cancelled; an already submitted request may still be billed.");
  if (error instanceof APITimeoutError) return new TypeSafeIntegrationError("timeout", "TypeSafe request timed out; it was not retried and may still be billed.");
  if (error instanceof APIError) {
    const advice = error.status === 401 ? "Check TYPESAFE_API_KEY."
      : error.status === 403 ? "Check your account access and model permissions."
      : error.status === 429 ? "Check your account quota and try again later."
      : error.status === 400 || error.status === 422 ? "Check the question format and model limits."
      : "Try again later or check the service status.";
    return new TypeSafeIntegrationError("http", `TypeSafe returned HTTP ${error.status}. ${advice} No automatic retry was made.`, error.status);
  }
  if (error instanceof APIConnectionError) return new TypeSafeIntegrationError("connection", "Could not complete the TypeSafe connection. No automatic retry was made.");
  return new TypeSafeIntegrationError("response", "TypeSafe returned an unreadable or unexpected response.");
}
