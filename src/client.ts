import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Fetch, Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { recordAuthFailure, recordAuthVerified } from "./auth.js";
import { DEFAULT_BACKEND, TYPESAFE_KEY_ENV, backendConfig, backendModelId, defaultModelId, usesTypesafeKey } from "./backends.js";
import type { BackendConfig, TypeSafeBackend } from "./backends.js";
import type { BatchEvaluation, BatchOptions } from "./batch.js";
import { evaluateAll, evaluateMany } from "./batch.js";
import { keySituation } from "./credentials.js";
import { TypeSafeIntegrationError, safeError } from "./errors.js";
import { DEFAULT_MAX_INPUT_BYTES, assertWithinByteLimit, prepareEvaluationRequest } from "./schema.js";
import { DEFAULT_USD_PER_MTOK, capsFromEnvironment, estimateUsd, mergeCaps, openUsageLedger } from "./usage.js";
import type { BlockedCap, SpendCaps, UsageLedger, UsageReport } from "./usage.js";

export { DECISIONS_BACKENDS, DEFAULT_BACKEND } from "./backends.js";
export type { BackendConfig, TypeSafeBackend } from "./backends.js";

/** The paths the SDK appends to whatever base URL it is given. */
const SDK_PATH = "/v1/systemone";
const SDK_MODELS_PATH = "/v1/models";

/**
 * Send the SDK's fixed paths to the backend's own, preserving any caller-supplied transport. A backend that serves
 * its model list under another path also gets that list renamed to the field the SDK reads.
 */
function backendFetch(backend: BackendConfig, inner: Fetch = fetch): Fetch {
  const { path, modelsPath, modelsField } = backend;
  return async (input, init) => {
    const url = String(input);
    const models = modelsPath !== undefined && url.includes(SDK_MODELS_PATH);
    const rewrite = models ? modelsPath : path;
    const response = await inner(rewrite === undefined ? url : url.replace(models ? SDK_MODELS_PATH : SDK_PATH, rewrite), init);
    return models && modelsField !== undefined ? translateModels(response, backend) : response;
  };
}

/**
 * Hand the SDK the list it expects: the field it reads, and the entry value callers pass as `model:` when the backend
 * labels models differently. Status and headers survive; a body without the declared field is passed through
 * unchanged, so the SDK still reports its own shape error.
 */
async function translateModels(response: Response, backend: BackendConfig): Promise<Response> {
  const { modelsField, modelsIdField } = backend;
  const text = await response.text();
  let wire: unknown;
  try { wire = JSON.parse(text); } catch { wire = undefined; }
  const list = modelsField !== undefined && wire !== null && typeof wire === "object" ? (wire as Record<string, unknown>)[modelsField] : undefined;
  const headers = new Headers(response.headers);
  // The body is replaced, so a copied length would describe the old one.
  headers.delete("content-length");
  headers.delete("content-encoding");
  const send = (body: string) => new Response(body, { status: response.status, statusText: response.statusText, headers });
  if (!Array.isArray(list)) return send(text);
  const models = list.map(entry => {
    if (modelsIdField === undefined || entry === null || typeof entry !== "object") return entry;
    const id = (entry as Record<string, unknown>)[modelsIdField];
    return typeof id === "string" && id.length > 0 ? { ...entry, name: id } : entry;
  });
  return send(JSON.stringify({ models }));
}

export interface TypeSafeOptions {
  /** Defaults to TYPESAFE_API_KEY, then the key saved by `/typesafe login`; never returned. */
  apiKey?: string;
  /** Judgment backend. When omitted, routes to the default TypeSafe host. */
  backend?: TypeSafeBackend;
  /** Defaults to the backend's own default (`jev-latest`, `typesafe/jev-1.13` on OpenRouter); a bare Jev id is mapped to the backend's id form before sending. No model is inferred from submitted content. */
  model?: string;
  /** Per request. Default: 15 seconds. No automatic retries. */
  timeoutMs?: number;
  /** UTF-8 JSON bytes, including model/questions. Default: 64 KiB. Not a token limit. */
  maxInputBytes?: number;
  /** Attempts per client instance, including failed network requests. Default: 20. */
  maxRequests?: number;
  /** Requests per local day, counted across processes and restarts. Unlimited by default. */
  maxRequestsPerDay?: number;
  /** Input tokens per local day. Unlimited by default. */
  maxInputTokensPerDay?: number;
  /** Estimated spend per local day, in US dollars. Unlimited by default. */
  maxUsdPerDay?: number;
  /** Price used for the cost estimate and the USD cap. Default: DEFAULT_USD_PER_MTOK. */
  usdPerMTok?: number;
  /** The usage ledger; defaults to the store next to the key. Injected by tests. */
  ledger?: UsageLedger;
  /** Transport injection for extension authors and offline tests. */
  fetch?: Fetch;
}
export interface EvaluationOptions { signal?: AbortSignal }
export type Evaluation<Q extends Questions> = SystemOneResult<Q> & { readonly elapsedMs: number };

/** Session counters for one client instance, plus the cost estimate they add up to. */
export interface UsageSnapshot {
  readonly requestsStarted: number;
  readonly requestsSucceeded: number;
  readonly requestsFailed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedUsd: number;
}

/** Session counters, today's persisted counters, the caps in force, and the cap that is currently reached. */
export interface SpendReport {
  readonly session: UsageSnapshot;
  readonly today: UsageReport;
  readonly caps: SpendCaps;
  readonly usdPerMTok: number;
  readonly blocked?: BlockedCap;
}

export interface TypeSafe {
  evaluate<Q extends Questions>(request: SystemOneRequest<Q>, options?: EvaluationOptions): Promise<Evaluation<Q>>;
  /** Several requests with bounded concurrency; answers, usage, and model merged. Never throws. */
  evaluateMany<Q extends Questions>(requests: readonly SystemOneRequest<Q>[], options?: BatchOptions): Promise<BatchEvaluation<Q>>;
  /** One state, any number of questions: chunk to the per-request limit, then fan out. Never throws. */
  evaluateAll<Q extends Questions>(request: SystemOneRequest<Q>, options?: BatchOptions & { maxQuestions?: number }): Promise<BatchEvaluation<Q>>;
  /** Model names available to the account. Verifies the key; does not count toward maxRequests. */
  listModels(options?: EvaluationOptions): Promise<string[]>;
  /** This client's session counters. */
  getUsage(): UsageSnapshot;
  /** Session counters, today's persisted totals, and the caps that stop the next request. */
  getSpend(): SpendReport;
}

/** Default attempts per client instance; the extension quotes the same number in its consent copy. */
export const DEFAULT_MAX_REQUESTS = 20;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeSafeIntegrationError("configuration", `${label} must be a positive safe integer.`);
  }
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeSafeIntegrationError("configuration", `${label} must be a positive number.`);
  }
  return value;
}

function validResult<Q extends Questions>(result: SystemOneResult<Q>, questions: Q): boolean {
  const probability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
  if (!result || typeof result.model !== "string" || !result.model || !result.usage || !result.answers) return false;
  for (const count of [result.usage.input_tokens, result.usage.output_tokens]) {
    if (!Number.isSafeInteger(count) || count < 0) return false;
  }
  if (Object.keys(result.answers).length !== Object.keys(questions).length) return false;
  for (const [id, question] of Object.entries(questions)) {
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type) return false;
    if (answer.type === "noul") {
      if (!probability(answer.noul)) return false;
      continue;
    }
    if (!probability(answer.confidence) || !answer.probabilities) return false;
    const keys = question.type === "choice" ? Object.keys(question.criteria)
      : question.type === "score" ? question.criteria.map((_, index) => String(index)) : [];
    const probabilities = new Map(Object.entries(answer.probabilities));
    if (probabilities.size !== keys.length || keys.some(key => !probability(probabilities.get(key) ?? NaN))) return false;
    if (answer.type === "choice" && !keys.includes(answer.choice)) return false;
    if (answer.type === "score" && (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1 || !answer.legend)) return false;
  }
  return true;
}

const CAP_LABELS: Record<BlockedCap["cap"], string> = {
  requestsPerDay: "daily request cap",
  inputTokensPerDay: "daily input-token cap",
  usdPerDay: "daily spend cap",
};

function capsDescription(caps: SpendCaps): string {
  const parts = [
    caps.maxRequests === undefined ? undefined : `${caps.maxRequests} per session`,
    caps.maxRequestsPerDay === undefined ? undefined : `${caps.maxRequestsPerDay} requests per day`,
    caps.maxInputTokensPerDay === undefined ? undefined : `${caps.maxInputTokensPerDay} input tokens per day`,
    caps.maxUsdPerDay === undefined ? undefined : `$${caps.maxUsdPerDay} per day`,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? `Caps: ${parts.join(", ")}.` : "No request or spend caps are set.";
}

/** A bounded, server-side TypeSafe client independent of Pi's runtime. */
export function createTypeSafe(options: TypeSafeOptions = {}): TypeSafe {
  let apiKey = options.apiKey?.trim();
  const backendName: TypeSafeBackend = options.backend ?? DEFAULT_BACKEND;
  const backend = backendConfig(backendName);
  const baseURL = backend.host;

  if (!apiKey) {
    // The same resolution that authState() and ensureApiKey() report, so the status line and the request agree.
    const situation = keySituation(backendName);
    if (situation.kind === "unusable") throw new TypeSafeIntegrationError("configuration", situation.reason);
    if (situation.kind === "environment" || situation.kind === "stored") apiKey = situation.key;
  }
  if (!apiKey) {
    const how = usesTypesafeKey(backend) ? `Run /typesafe login in Pi, or set ${TYPESAFE_KEY_ENV}` : `Set ${backend.keyEnv}`;
    throw new TypeSafeIntegrationError("configuration", `No API key. ${how} in the environment.`);
  }
  const timeout = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
  const maxInputBytes = positiveInteger(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, "maxInputBytes");
  const maxRequests = positiveInteger(options.maxRequests ?? DEFAULT_MAX_REQUESTS, "maxRequests");
  const usdPerMTok = positiveNumber(options.usdPerMTok ?? DEFAULT_USD_PER_MTOK, "usdPerMTok");
  const caps = mergeCaps({
    maxRequests,
    ...(options.maxRequestsPerDay === undefined ? {} : { maxRequestsPerDay: positiveInteger(options.maxRequestsPerDay, "maxRequestsPerDay") }),
    ...(options.maxInputTokensPerDay === undefined ? {} : { maxInputTokensPerDay: positiveInteger(options.maxInputTokensPerDay, "maxInputTokensPerDay") }),
    ...(options.maxUsdPerDay === undefined ? {} : { maxUsdPerDay: positiveNumber(options.maxUsdPerDay, "maxUsdPerDay") }),
  }, capsFromEnvironment());
  // A backend that serves its own paths gets a transport that rewrites them; the default backend keeps the caller's.
  const transport = backend.path !== undefined || backend.modelsPath !== undefined ? backendFetch(backend, options.fetch) : options.fetch;
  // The caller's input is validated as written, then mapped to the backend's id form; omitting it sends the backend's
  // own default, which the mapping leaves unchanged.
  const requested = options.model ?? defaultModelId(backendName);
  if (typeof requested !== "string" || !requested.trim() || requested.length > 100) throw new TypeSafeIntegrationError("configuration", "model must be a nonempty string of at most 100 characters.");
  const model = backendModelId(backendName, requested);
  // Do not inherit SDK debug logging or alternate destinations from the environment.
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: model,
    baseURL,
    timeout,
    retry: { maxRetries: 0 },
    logLevel: "off",
    ...(transport ? { fetch: transport } : {}),
  });
  const ledger = options.ledger ?? openUsageLedger({ usdPerMTok });
  const usage = { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0 };
  // Auth state writes are deduplicated: one verification record per process, one record per distinct failure.
  let verificationRecorded = false;
  let lastFailureRecorded: string | undefined;

  const snapshot = (): UsageSnapshot => ({ ...usage, estimatedUsd: estimateUsd(usage.inputTokens, usdPerMTok) });
  const blocked = (): BlockedCap | undefined => (usage.requestsStarted >= maxRequests ? undefined : ledger.blocked(caps));

  const typesafe: TypeSafe = {
    getUsage: snapshot,
    getSpend: () => {
      const reached = blocked();
      return {
        session: snapshot(),
        today: ledger.today(),
        caps,
        usdPerMTok,
        ...(reached === undefined ? {} : { blocked: reached }),
      };
    },
    async listModels(callOptions: EvaluationOptions = {}): Promise<string[]> {
      try {
        const models = await client.models.list(callOptions);
        if (!Array.isArray(models)) throw new TypeSafeIntegrationError("response", "TypeSafe returned an unexpected model list.");
        // A backend that serves its list publicly accepts any key, so a success there proves nothing about one.
        if (backend.modelsVerifyKey !== false && !verificationRecorded) {
          verificationRecorded = true;
          recordAuthVerified();
        }
        return models.map(card => card?.name).filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 100);
      } catch (error) {
        throw safeError(error, backend);
      }
    },
    async evaluate<Q extends Questions>(input: SystemOneRequest<Q>, callOptions: EvaluationOptions = {}): Promise<Evaluation<Q>> {
      const validated = prepareEvaluationRequest(input, { maxInputBytes });
      // A per-request model meets the same mapping as the client default; the schema already limited the caller's own id.
      const body = JSON.stringify({ ...validated, model: validated.model === undefined ? model : backendModelId(backendName, validated.model) });
      assertWithinByteLimit(body, maxInputBytes);
      if (callOptions.signal?.aborted) throw new TypeSafeIntegrationError("aborted", "TypeSafe request cancelled before submission.");
      if (usage.requestsStarted >= maxRequests) {
        throw new TypeSafeIntegrationError("budget", `TypeSafe request limit reached (${maxRequests} attempts per client instance). ${capsDescription(caps)}`);
      }
      const reached = ledger.blocked(caps);
      if (reached) {
        // Name the cap, the used amount, and the day, so a long run stops loudly instead of burning tokens unnoticed.
        throw new TypeSafeIntegrationError("budget", `TypeSafe ${CAP_LABELS[reached.cap]} reached (${reached.used} of ${reached.limit} on ${reached.day}); no request was submitted. Requests resume after the local day rolls over, or raise the cap deliberately.`);
      }
      // Snapshot before awaiting so later mutations cannot change the request or validation.
      const request = JSON.parse(body) as SystemOneRequest<Q>;
      usage.requestsStarted += 1;
      ledger.recordStart();
      const start = performance.now();
      try {
        const result = await client.systemOne(request, callOptions);
        if (!validResult(result, request.questions)) throw new TypeSafeIntegrationError("response", "TypeSafe returned an unexpected answer or usage format.");
        usage.requestsSucceeded += 1;
        usage.inputTokens += result.usage.input_tokens;
        usage.outputTokens += result.usage.output_tokens;
        ledger.recordSuccess(result.usage.input_tokens, result.usage.output_tokens);
        if (!verificationRecorded) {
          verificationRecorded = true;
          recordAuthVerified();
        }
        return { ...result, elapsedMs: Math.round(performance.now() - start) };
      } catch (error) {
        const safe = safeError(error, backend);
        // The request was submitted, so it counts even when it fails; the reason stays visible in `authState()`.
        usage.requestsFailed += 1;
        ledger.recordFailure();
        const fingerprint = `${safe.code}:${safe.status ?? ""}:${safe.message}`;
        if (lastFailureRecorded !== fingerprint) {
          lastFailureRecorded = fingerprint;
          recordAuthFailure(safe);
        }
        throw safe;
      }
    },
    evaluateMany: <Q extends Questions>(requests: readonly SystemOneRequest<Q>[], batchOptions: BatchOptions = {}) => evaluateMany(typesafe, requests, batchOptions),
    evaluateAll: <Q extends Questions>(request: SystemOneRequest<Q>, batchOptions: BatchOptions & { maxQuestions?: number } = {}) => evaluateAll(typesafe, request, batchOptions),
  };
  return typesafe;
}
