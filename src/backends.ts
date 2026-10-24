import { TypeSafeIntegrationError } from "./errors.js";
import { DEFAULT_BACKEND_LIMITS } from "./schema.js";
import type { BackendLimits } from "./schema.js";

export type TypeSafeBackend = "typesafe" | "openrouter" | "commandcode" | "liquid" | "subq";

export interface BackendConfig {
  /** Human name for status lines: "TypeSafe", "OpenRouter", "Command Code", "Liquid AI", "SubQ". */
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
  /** What one request may ask, where the backend accepts less than the schema. An absent field keeps the schema's bound. */
  limits?: Readonly<Partial<BackendLimits>>;
}

/** A registry entry: a backend config that can also name a price per model. Caller-supplied endpoints carry none. */
export interface RegistryBackendConfig extends BackendConfig {
  /** USD per million input tokens, by the model id as it is sent. A model with no entry is priced at DEFAULT_USD_PER_MTOK. */
  prices?: Readonly<Record<string, number>>;
}

/** A caller-supplied endpoint that serves the Jev decisions protocol. Passed per call; never added to the registry. */
export interface BackendEndpoint extends BackendConfig {
  /** Required. The environment variable with this endpoint's key. Must not be TYPESAFE_API_KEY. */
  readonly keyEnv: string;
  /** Model sent when the caller names none. Without it, `model` must be passed to createTypeSafe. */
  readonly defaultModel?: string;
}

/** A registry name or a caller-supplied endpoint. */
export type BackendSpec = TypeSafeBackend | BackendEndpoint;

/** A backend resolved and validated: what the client will actually use. */
export interface ResolvedBackend extends RegistryBackendConfig {
  /** Registry name, absent for a caller-supplied endpoint. */
  readonly name?: TypeSafeBackend;
  /** Origin only: scheme, host, and port. */
  readonly host: string;
  readonly keyEnv: string;
  /** The model id sent when the caller names none, already in the backend's form. Absent when the endpoint names none. */
  readonly defaultModel?: string;
  /** Always explicit after resolution. */
  readonly modelsVerifyKey: boolean;
  /** Every limit explicit: the backend's own, else the schema's bound. */
  readonly limits: BackendLimits;
}

/** The backend every key and auth function assumes when none is named. */
export const DEFAULT_BACKEND: TypeSafeBackend = "typesafe";

/** The environment variable and login store that the default backend reads. */
export const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";

/** Registry of known judgment backends. Callers pass a `BackendEndpoint` for a host this registry does not name. */
export const DECISIONS_BACKENDS: Record<TypeSafeBackend, RegistryBackendConfig> = {
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
  commandcode: {
    label: "Command Code",
    host: "https://api.commandcode.ai",
    keyEnv: "COMMANDCODE_API_KEY",
    path: "/provider/v1/systemone",
    modelsPath: "/provider/v1/models",
    modelsField: "data",
    modelsIdField: "id",
    modelsVerifyKey: false,
  },
  liquid: {
    label: "Liquid AI",
    host: "https://api.liquid.ai",
    keyEnv: "LIQUID_API_KEY",
    path: "/decisions/v1/systemone",
    modelsPath: "/decisions/v1/models",
    modelsVerifyKey: true,
    prices: { d1: 0.04, "d1:free": 0 },
  },
  subq: {
    label: "SubQ",
    host: "https://api.subq.ai",
    keyEnv: "SUBQ_API_KEY",
    modelsField: "data",
    modelsIdField: "id",
    modelsVerifyKey: false,
    // SubQ answers 422 to 17 questions, a 1-option Choice, or an 11-level Score. Its 255-option Choice cap is above the schema's 64.
    limits: { maxQuestions: 16, minChoiceOptions: 2, maxScoreLevels: 10 },
    prices: { "subq-snap-preview": 0.05 },
  },
};

/** The registry entry for a backend name; a `configuration` error for a name the registry does not know. */
export function backendConfig(name: TypeSafeBackend): RegistryBackendConfig {
  // A bare lookup finds `toString` on Object.prototype, so only an own entry is a backend.
  const backend = Object.hasOwn(DECISIONS_BACKENDS, name) ? DECISIONS_BACKENDS[name] : undefined;
  if (!backend) throw new TypeSafeIntegrationError("configuration", `Unknown judgment backend "${name}". Valid backends: ${Object.keys(DECISIONS_BACKENDS).join(", ")}.`);
  return backend;
}

/** The environment variable naming the judgment backend a Pi session uses; unset means `typesafe`. */
export const BACKEND_ENV = "PI_TYPESAFE_BACKEND";

/** The environment variable overriding the backend's default model; unset sends the backend's own default. */
export const MODEL_ENV = "PI_TYPESAFE_MODEL";

/**
 * The backend a Pi session uses, from `PI_TYPESAFE_BACKEND`. An unset or blank variable means the default backend; a
 * name the registry does not know is a `configuration` error naming the valid names, so a typo fails loudly at
 * session start instead of silently sending judgments to a host the operator did not choose.
 */
export function backendFromEnvironment(env: NodeJS.ProcessEnv = process.env): TypeSafeBackend {
  const name = env[BACKEND_ENV]?.trim();
  if (!name) return DEFAULT_BACKEND;
  backendConfig(name as TypeSafeBackend);
  return name as TypeSafeBackend;
}

/**
 * The model the Pi session sends, from `PI_TYPESAFE_MODEL`; `undefined` when unset or blank, so the backend's own
 * default applies. Returned as the caller wrote it: the client maps it to the backend's id form.
 */
export function modelFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[MODEL_ENV]?.trim() || undefined;
}

/** Each backend's default model id as the caller writes it, before mapping: OpenRouter pins a version, TypeSafe follows latest. */
const DEFAULT_MODEL: Record<TypeSafeBackend, string> = {
  typesafe: "jev-latest",
  openrouter: "typesafe/jev-1.13",
  commandcode: "typesafe/jev",
  liquid: "d1:free",
  subq: "subq-snap-preview",
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
 * The registry's price for a model, in USD per million input tokens, or undefined when the backend names none.
 * `model` is the id as sent. A caller-supplied endpoint has no prices.
 */
export function backendPrice(backend: ResolvedBackend, model: string): number | undefined {
  const prices = backend.prices;
  return prices !== undefined && Object.hasOwn(prices, model) ? prices[model] : undefined;
}

/**
 * Whether a backend's key comes from the TypeSafe resolution (`TYPESAFE_API_KEY`, then the login store) or only from
 * its own environment variable. Only the TypeSafe backend has a login store; every other backend is environment-only.
 */
export function usesTypesafeKey(backend: BackendConfig): boolean {
  return (backend.keyEnv ?? TYPESAFE_KEY_ENV) === TYPESAFE_KEY_ENV;
}

const KEY_ENV_MESSAGE = "Backend keyEnv must name an environment variable: letters, digits, and underscores, not starting with a digit.";
const HOST_MESSAGE = "Backend host must be an absolute https: URL with no user info, path, query, or fragment (http: is allowed only for localhost, 127.0.0.0/8, and [::1]).";

function refuse(message: string): never {
  throw new TypeSafeIntegrationError("configuration", message);
}

/** `https://gw.example.com?` and `https://gw.example.com#` parse clean, so the raw string itself must carry neither. */
function hasRawQueryOrFragment(value: string): boolean {
  return value.includes("?") || value.includes("#");
}

const LIMITS_MESSAGE = `Backend limits must be an object of whole numbers within the schema's bounds: maxQuestions 1–${DEFAULT_BACKEND_LIMITS.maxQuestions}, minChoiceOptions and maxChoiceOptions ${DEFAULT_BACKEND_LIMITS.minChoiceOptions}–${DEFAULT_BACKEND_LIMITS.maxChoiceOptions} with min at most max, maxScoreLevels 2–${DEFAULT_BACKEND_LIMITS.maxScoreLevels}.`;

/** An endpoint's limits, each within the schema's bound: a backend can narrow what the schema admits, never widen it. */
function resolveLimits(value: unknown): BackendLimits {
  if (value === undefined) return { ...DEFAULT_BACKEND_LIMITS };
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(LIMITS_MESSAGE);
  const given = value as Record<string, unknown>;
  const floors: Record<keyof BackendLimits, number> = { maxQuestions: 1, minChoiceOptions: DEFAULT_BACKEND_LIMITS.minChoiceOptions, maxChoiceOptions: DEFAULT_BACKEND_LIMITS.minChoiceOptions, maxScoreLevels: 2 };
  const ceilings: Record<keyof BackendLimits, number> = { ...DEFAULT_BACKEND_LIMITS, minChoiceOptions: DEFAULT_BACKEND_LIMITS.maxChoiceOptions };
  for (const key of Object.keys(given)) if (!Object.hasOwn(floors, key)) refuse(LIMITS_MESSAGE);
  const limits: Record<keyof BackendLimits, number> = { ...DEFAULT_BACKEND_LIMITS };
  for (const key of Object.keys(floors) as (keyof BackendLimits)[]) {
    const field = given[key];
    if (field === undefined) continue;
    if (typeof field !== "number" || !Number.isInteger(field) || field < floors[key] || field > ceilings[key]) refuse(LIMITS_MESSAGE);
    limits[key] = field;
  }
  if (limits.minChoiceOptions > limits.maxChoiceOptions) refuse(LIMITS_MESSAGE);
  return limits;
}

/**
 * Resolve a registry name or a caller-supplied endpoint into the validated form the client uses. A name resolves to
 * its registry entry unchanged; an endpoint is validated field by field and returned as a fresh object whose `host`
 * is origin-only. Messages never quote a caller value — a host can carry credentials in its user info — except the
 * label, and only after it is validated. Validation runs on every call; nothing is cached.
 */
export function resolveBackend(backend?: BackendSpec): ResolvedBackend {
  const spec: BackendSpec = backend === undefined ? DEFAULT_BACKEND : backend;
  if (typeof spec === "string") {
    const entry = backendConfig(spec);
    return {
      ...entry,
      name: spec,
      host: entry.host,
      keyEnv: entry.keyEnv ?? TYPESAFE_KEY_ENV,
      defaultModel: defaultModelId(spec),
      modelsVerifyKey: entry.modelsVerifyKey !== false,
      limits: { ...DEFAULT_BACKEND_LIMITS, ...entry.limits },
    };
  }
  if (spec === null || typeof spec !== "object") {
    refuse("backend must be a registry name or a backend object.");
  }
  const label = typeof spec.label === "string" ? spec.label.trim() : "";
  if (!label || label.length > 60) refuse("Backend label must be a nonempty string of at most 60 characters.");
  let host: URL;
  if (typeof spec.host !== "string" || hasRawQueryOrFragment(spec.host)) refuse(HOST_MESSAGE);
  try {
    host = new URL(spec.host);
  } catch {
    refuse(HOST_MESSAGE);
  }
  const loopback = host.hostname === "localhost" || host.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host.hostname);
  if (host.protocol !== "https:" && !(host.protocol === "http:" && loopback)) refuse(HOST_MESSAGE);
  if (host.username !== "" || host.password !== "" || host.pathname !== "/" || host.search !== "" || host.hash !== "") refuse(HOST_MESSAGE);
  for (const [field, message] of [["path", 'Backend path must be a string that starts with "/".'], ["modelsPath", 'Backend modelsPath must be a string that starts with "/".']] as const) {
    const value = spec[field];
    if (value !== undefined && (typeof value !== "string" || !value.startsWith("/") || hasRawQueryOrFragment(value))) refuse(message);
  }
  if (spec.modelsField !== undefined && (typeof spec.modelsField !== "string" || !spec.modelsField)) refuse("Backend modelsField must be a nonempty string.");
  if (spec.modelsIdField !== undefined && (typeof spec.modelsIdField !== "string" || !spec.modelsIdField)) refuse("Backend modelsIdField must be a nonempty string.");
  if (spec.modelsVerifyKey !== undefined && typeof spec.modelsVerifyKey !== "boolean") refuse("Backend modelsVerifyKey must be a boolean.");
  const limits = resolveLimits(spec.limits);
  if (typeof spec.keyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.keyEnv)) refuse(KEY_ENV_MESSAGE);
  if (spec.keyEnv.toUpperCase() === TYPESAFE_KEY_ENV) {
    refuse("Backend keyEnv must not be TYPESAFE_API_KEY: the TypeSafe key is only sent to the typesafe backend. Give this endpoint its own variable.");
  }
  if (spec.defaultModel !== undefined && (typeof spec.defaultModel !== "string" || !spec.defaultModel.trim() || spec.defaultModel.length > 100)) {
    refuse("Backend defaultModel must be a nonempty string of at most 100 characters.");
  }
  return {
    label,
    host: host.origin,
    keyEnv: spec.keyEnv,
    modelsVerifyKey: spec.modelsVerifyKey === true,
    limits,
    ...(spec.path === undefined ? {} : { path: spec.path }),
    ...(spec.modelsPath === undefined ? {} : { modelsPath: spec.modelsPath }),
    ...(spec.modelsField === undefined ? {} : { modelsField: spec.modelsField }),
    ...(spec.modelsIdField === undefined ? {} : { modelsIdField: spec.modelsIdField }),
    ...(spec.defaultModel === undefined ? {} : { defaultModel: spec.defaultModel }),
  };
}

/** The destination host only — scheme, host, and port, e.g. `api.commandcode.ai` — for consent text. */
export function backendHost(backend?: BackendSpec): string {
  return new URL(resolveBackend(backend).host).host;
}
