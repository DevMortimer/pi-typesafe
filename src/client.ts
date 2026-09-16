import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Fetch, Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { resolveApiKey } from "./credentials.js";
import { TypeSafeIntegrationError, safeError } from "./errors.js";
import { parseEvaluationRequest } from "./schema.js";

export interface TypeSafeOptions {
  /** Defaults to TYPESAFE_API_KEY, then the key saved by `/typesafe login`; never returned. */
  apiKey?: string;
  /** Defaults to jev-latest. No model is inferred from submitted content. */
  model?: string;
  /** Per request. Default: 15 seconds. No automatic retries. */
  timeoutMs?: number;
  /** UTF-8 JSON bytes, including model/questions. Default: 64 KiB. Not a token limit. */
  maxInputBytes?: number;
  /** Attempts per client instance, including failed network requests. Default: 20. */
  maxRequests?: number;
  /** Transport injection for extension authors and offline tests. */
  fetch?: Fetch;
}
export interface EvaluationOptions { signal?: AbortSignal }
export type Evaluation<Q extends Questions> = SystemOneResult<Q> & { readonly elapsedMs: number };
export interface UsageSnapshot {
  readonly requestsStarted: number;
  readonly requestsSucceeded: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface TypeSafe {
  evaluate<Q extends Questions>(request: SystemOneRequest<Q>, options?: EvaluationOptions): Promise<Evaluation<Q>>;
  /** Model names available to the account. Verifies the key; does not count toward maxRequests. */
  listModels(options?: EvaluationOptions): Promise<string[]>;
  getUsage(): UsageSnapshot;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeSafeIntegrationError("configuration", `${label} must be a positive safe integer.`);
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

/** A bounded, server-side TypeSafe client independent of Pi's runtime. */
export function createTypeSafe(options: TypeSafeOptions = {}): TypeSafe {
  const apiKey = options.apiKey?.trim() || resolveApiKey()?.key;
  if (!apiKey) throw new TypeSafeIntegrationError("configuration", "No TypeSafe API key. Run /typesafe login in Pi, or set TYPESAFE_API_KEY in the environment.");
  const timeout = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
  const maxInputBytes = positiveInteger(options.maxInputBytes ?? 65_536, "maxInputBytes");
  const maxRequests = positiveInteger(options.maxRequests ?? 20, "maxRequests");
  const model = options.model ?? "jev-latest";
  if (typeof model !== "string" || !model.trim() || model.length > 100) throw new TypeSafeIntegrationError("configuration", "model must be a nonempty string of at most 100 characters.");
  // Do not inherit SDK debug logging or alternate destinations from the environment.
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: model,
    baseURL: "https://api.typesafe.ai",
    timeout,
    retry: { maxRetries: 0 },
    logLevel: "off",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const usage = { requestsStarted: 0, requestsSucceeded: 0, inputTokens: 0, outputTokens: 0 };

  return {
    getUsage: () => ({ ...usage }),
    async listModels(callOptions: EvaluationOptions = {}): Promise<string[]> {
      try {
        const models = await client.models.list(callOptions);
        if (!Array.isArray(models)) throw new TypeSafeIntegrationError("response", "TypeSafe returned an unexpected model list.");
        return models.map(card => card?.name).filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 100);
      } catch (error) {
        throw safeError(error);
      }
    },
    async evaluate<Q extends Questions>(input: SystemOneRequest<Q>, callOptions: EvaluationOptions = {}): Promise<Evaluation<Q>> {
      const validated = parseEvaluationRequest(input);
      const body = JSON.stringify({ ...validated, model: validated.model ?? model });
      if (Buffer.byteLength(body, "utf8") > maxInputBytes) throw new TypeSafeIntegrationError("validation", `Evaluation exceeds the ${maxInputBytes}-byte input limit.`);
      if (callOptions.signal?.aborted) throw new TypeSafeIntegrationError("aborted", "TypeSafe request cancelled before submission.");
      if (usage.requestsStarted >= maxRequests) throw new TypeSafeIntegrationError("budget", `TypeSafe request limit reached (${maxRequests} attempts per client instance).`);
      // Snapshot before awaiting so later mutations cannot change the request or validation.
      const request = JSON.parse(body) as SystemOneRequest<Q>;
      usage.requestsStarted += 1;
      const start = performance.now();
      try {
        const result = await client.systemOne(request, callOptions);
        if (!validResult(result, request.questions)) throw new TypeSafeIntegrationError("response", "TypeSafe returned an unexpected answer or usage format.");
        usage.requestsSucceeded += 1;
        usage.inputTokens += result.usage.input_tokens;
        usage.outputTokens += result.usage.output_tokens;
        return { ...result, elapsedMs: Math.round(performance.now() - start) };
      } catch (error) {
        throw safeError(error);
      }
    },
  };
}
