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

/** Each backend's default model id as the caller writes it, before mapping: OpenRouter pins a version, TypeSafe follows latest. */
const DEFAULT_MODEL: Record<TypeSafeBackend, string> = {
  typesafe: "jev-latest",
  openrouter: "typesafe/jev-1.13",
};

/**
 * The model id to send for a caller's `model` on this backend. OpenRouter routes a bare Jev id under the `typesafe`
 * author: `jev-latest` becomes its alias form `~typesafe/jev-latest`, and a bare `jev-<major>.<minor>` — with or
 * without TypeSafe direct's optional `.<patch>` segment — becomes `typesafe/jev-<major>.<minor>`. An id that already
 * carries an author (`vendor/model`), a bare id this rule does not know, and every model on a backend without a
 * mapping go through unchanged. Every mapped id contains `/`, so mapping an already-mapped id changes nothing.
 */
export function backendModelId(backend: TypeSafeBackend, model: string): string {
  if (model.includes("/")) return model;
  if (backend !== "openrouter") return model;
  if (model === "jev-latest") return "~typesafe/jev-latest";
  const version = /^jev-(\d+)\.(\d+)(?:\.\d+)?$/.exec(model);
  return version === null ? model : `typesafe/jev-${version[1]}.${version[2]}`;
}

/** The model a client sends when the caller names none: the backend's own default, in the form that backend accepts. */
export function defaultModelId(backend: TypeSafeBackend): string {
  return backendModelId(backend, DEFAULT_MODEL[backend]);
}

/**
 * Whether a backend's key comes from the TypeSafe resolution (`TYPESAFE_API_KEY`, then the login store) or only from
 * its own environment variable. Only the TypeSafe backend has a login store; every other backend is environment-only.
 */
export function usesTypesafeKey(backend: BackendConfig): boolean {
  return (backend.keyEnv ?? TYPESAFE_KEY_ENV) === TYPESAFE_KEY_ENV;
}
