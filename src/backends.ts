import { TypeSafeIntegrationError } from "./errors.js";

export type TypeSafeBackend = "typesafe" | "openrouter";

export interface BackendConfig {
  /** Human name for status lines: "TypeSafe", "OpenRouter". */
  label: string;
  host: string;
  /** The environment variable that carries this backend's key. Absent means the TypeSafe key resolution applies. */
  keyEnv?: string;
  /** Request path, when the backend does not serve the SDK's own `/v1/systemone`. */
  path?: string;
  /** Request path for the model list, when the backend does not serve the SDK's own `/v1/models`. */
  modelsPath?: string;
  /** Field the model list arrives in, when the backend does not use the SDK's own `models`. */
  modelsField?: string;
  /** Entry field carrying the id callers pass as `model:`, when the SDK's own `name` is only a label. */
  modelsIdField?: string;
  /** Whether the model list checks the key. A public list accepts any key, so it proves nothing. Absent means it does. */
  modelsVerifyKey?: boolean;
}

/** The backend every key and auth function assumes when none is named. */
export const DEFAULT_BACKEND: TypeSafeBackend = "typesafe";

/** The environment variable and login store that the default backend reads. */
export const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";

/** Registry of known judgment backends. Extendable by callers. */
export const DECISIONS_BACKENDS: Record<TypeSafeBackend, BackendConfig> = {
  typesafe: { label: "TypeSafe", host: "https://api.typesafe.ai", keyEnv: TYPESAFE_KEY_ENV },
  openrouter: {
    label: "OpenRouter",
    host: "https://openrouter.ai",
    keyEnv: "OPENROUTER_API_KEY",
    path: "/api/alpha/decisions",
    modelsPath: "/api/v1/models",
    modelsField: "data",
    modelsIdField: "id",
    modelsVerifyKey: false,
  },
};

/** The registry entry for a backend name; a `configuration` error for a name the registry does not know. */
export function backendConfig(name: TypeSafeBackend): BackendConfig {
  const backend = DECISIONS_BACKENDS[name];
  if (!backend) throw new TypeSafeIntegrationError("configuration", `Unknown judgment backend "${name}". Valid backends: ${Object.keys(DECISIONS_BACKENDS).join(", ")}.`);
  return backend;
}

/**
 * Whether a backend's key comes from the TypeSafe resolution (`TYPESAFE_API_KEY`, then the login store) or only from
 * its own environment variable. Only the TypeSafe backend has a login store; every other backend is environment-only.
 */
export function usesTypesafeKey(backend: BackendConfig): boolean {
  return (backend.keyEnv ?? TYPESAFE_KEY_ENV) === TYPESAFE_KEY_ENV;
}
