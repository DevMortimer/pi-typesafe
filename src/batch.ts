import type { Questions, SystemOneRequest, Usage } from "@typesafe-ai/sdk";
import type { Evaluation, TypeSafe } from "./client.js";
import { TypeSafeIntegrationError } from "./errors.js";
import { resolveBackend } from "./backends.js";
import type { BackendSpec } from "./backends.js";
import { DEFAULT_BACKEND_LIMITS, prepareEvaluationRequest } from "./schema.js";

/** Default number of requests in flight. TypeSafe answers in isolation, so a small pool is enough. */
export const DEFAULT_CONCURRENCY = 4;

/** Terminal state of one item in a batch. */
export type SettledStatus = "succeeded" | "failed" | "skipped";

/** Why an unstarted batch item was skipped. */
export type SkipReason = "aborted" | "stopped";

/** One item's outcome. `status` discriminates every terminal state while keeping `ok` and `skipped` narrowable. */
export type Settled<T> =
  | { readonly status: "succeeded"; readonly ok: true; readonly index: number; readonly value: T }
  | { readonly status: "failed"; readonly ok: false; readonly skipped: false; readonly index: number; readonly error: unknown }
  | { readonly status: "skipped"; readonly ok: false; readonly skipped: true; readonly skipReason: SkipReason; readonly index: number; readonly error: TypeSafeIntegrationError };

type PoolState =
  | { readonly status: "running" }
  | { readonly status: "stopping"; readonly reason: SkipReason; readonly cause?: unknown };

// First stop transition wins so a late signal abort during drain cannot overwrite a prior stop cause.
function transitionPool(state: PoolState, reason: SkipReason, cause?: unknown): PoolState {
  if (state.status === "stopping") return state;
  return cause === undefined ? { status: "stopping", reason } : { status: "stopping", reason, cause };
}

function skippedItem(index: number, reason: SkipReason, cause?: unknown): Extract<Settled<never>, { status: "skipped" }> {
  if (reason === "aborted") {
    return {
      status: "skipped",
      ok: false,
      skipped: true,
      skipReason: "aborted",
      index,
      error: new TypeSafeIntegrationError("aborted", "TypeSafe batch cancelled before this request was submitted."),
    };
  }
  const error = cause instanceof TypeSafeIntegrationError && cause.code === "budget"
    ? new TypeSafeIntegrationError("budget", "TypeSafe batch stopped after a budget limit was reached; this request was not submitted.")
    : new TypeSafeIntegrationError("aborted", "TypeSafe batch stopped after a failed request; this request was not submitted.");
  return { status: "skipped", ok: false, skipped: true, skipReason: "stopped", index, error };
}

export interface FanOutOptions {
  /** Requests in flight at once. Default: DEFAULT_CONCURRENCY. */
  concurrency?: number;
  /** Stops starting new work once aborted; in-flight work still finishes. */
  signal?: AbortSignal;
  /** Stop launching new work once this returns true for a failure, e.g. a `budget` error. */
  stopOn?: (error: unknown) => boolean;
}

/**
 * Run `worker` over `items` with bounded concurrency, preserving input order. Never throws: every item comes back as a
 * settled result. This is the pool the client's batching methods use, exported so script authors stop hand-rolling one.
 */
export async function fanOut<I, O>(items: readonly I[], worker: (item: I, index: number) => Promise<O>, options: FanOutOptions = {}): Promise<Settled<O>[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const results = new Array<Settled<O> | undefined>(items.length);
  let next = 0;
  const pool: { state: PoolState } = { state: { status: "running" } };
  const stopPool = (reason: SkipReason, cause?: unknown): void => {
    pool.state = transitionPool(pool.state, reason, cause);
  };
  const onAbort = (): void => { stopPool("aborted"); };
  if (options.signal?.aborted) stopPool("aborted");
  else options.signal?.addEventListener?.("abort", onAbort, { once: true });

  const run = async (): Promise<void> => {
    while (pool.state.status === "running") {
      if (options.signal?.aborted) {
        stopPool("aborted");
        return;
      }
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "succeeded", ok: true, index, value: await worker(items[index] as I, index) };
      } catch (error) {
        results[index] = { status: "failed", ok: false, skipped: false, index, error };
        if (options.stopOn?.(error)) stopPool("stopped", error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  } finally {
    options.signal?.removeEventListener?.("abort", onAbort);
  }
  if (pool.state.status === "stopping") {
    for (let index = 0; index < items.length; index++) {
      if (!results[index]) results[index] = skippedItem(index, pool.state.reason, pool.state.cause);
    }
  }
  return results as Settled<O>[];
}

export interface BatchOptions {
  /** Requests in flight at once. Default: DEFAULT_CONCURRENCY. */
  concurrency?: number;
  signal?: AbortSignal;
}

/** Per-request outcomes plus the merged view callers usually want. */
export interface BatchEvaluation<Q extends Questions = Questions> {
  /** True when every request succeeded. */
  readonly ok: boolean;
  /** Per-request outcomes in input order. */
  readonly results: readonly Settled<Evaluation<Q>>[];
  /** Failures, including requests that were never submitted. */
  readonly failures: number;
  /** Work never started, because of an abort or a `budget` stop. */
  readonly skipped: number;
  /** Answers merged in input order; a repeated question id keeps the last answer. Empty when nothing succeeded. */
  readonly answers: Partial<Evaluation<Q>["answers"]>;
  /** The model of the first successful request, when there is one. */
  readonly model?: string;
  /** Usage summed over the requests that succeeded; a token count the API did not report adds nothing. */
  readonly usage: Usage;
  /** Wall-clock time for the whole batch. */
  readonly elapsedMs: number;
}

function summarize<Q extends Questions>(results: readonly Settled<Evaluation<Q>>[], elapsedMs: number): BatchEvaluation<Q> {
  const answers: Partial<Evaluation<Q>["answers"]> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let succeeded = 0;
  let skipped = 0;
  let model: string | undefined;
  for (const result of results) {
    switch (result.status) {
      case "succeeded":
        succeeded++;
        Object.assign(answers, result.value.answers);
        inputTokens += result.value.usage.input_tokens ?? 0;
        outputTokens += result.value.usage.output_tokens ?? 0;
        model ??= result.value.model;
        break;
      case "skipped":
        skipped++;
        break;
      case "failed":
        break;
    }
  }
  return {
    ok: succeeded === results.length,
    results,
    failures: results.length - succeeded,
    skipped,
    answers,
    ...(model === undefined ? {} : { model }),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    elapsedMs,
  };
}

/** A failure that is worth stopping the batch for: no more requests will be accepted, or the caller cancelled. */
function stopsBatch(error: unknown): boolean {
  return error instanceof TypeSafeIntegrationError && (error.code === "budget" || error.code === "aborted");
}

/**
 * Send several requests with bounded concurrency, in input order, and merge what came back. Each request passes through
 * the same admission seam as `evaluate`, so an invalid request is one settled failure, not a thrown error. A `budget` or
 * cancellation failure stops the rest from being submitted. Never throws.
 */
export async function evaluateMany<Q extends Questions>(
  client: TypeSafe,
  requests: readonly SystemOneRequest<Q>[],
  options: BatchOptions = {},
): Promise<BatchEvaluation<Q>> {
  const start = performance.now();
  const results = await fanOut(requests, (request) => client.evaluate(prepareEvaluationRequest(request) as SystemOneRequest<Q>, options.signal ? { signal: options.signal } : {}), {
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    stopOn: stopsBatch,
  });
  return summarize(results, Math.round(performance.now() - start));
}

/** A caller's chunk size, capped at the backend's question limit; the limit itself when the caller names none. */
function chunkSize(maxQuestions: number | undefined, backendMax: number): number {
  return Math.max(1, Math.min(backendMax, Math.floor(maxQuestions ?? backendMax)));
}

/**
 * Split a request that asks more questions than one request may carry into chunks of at most `maxQuestions`, capped at
 * the question limit of `backend` (default: the TypeSafe backend). Sharing one state across several questions is one
 * request; asking more than the per-request limit is the only reason to fan out, and the state is repeated in each
 * chunk. The order of `questions` is preserved. A pure splitter: admission still happens once per chunk, in `evaluate`
 * or `evaluateMany`, so what one accepts the others accept.
 */
export function chunkEvaluationRequest(
  request: SystemOneRequest<Questions>,
  options: { maxQuestions?: number; backend?: BackendSpec } = {},
): SystemOneRequest<Questions>[] {
  const limit = chunkSize(options.maxQuestions, resolveBackend(options.backend).limits.maxQuestions);
  return splitQuestions(request, limit);
}

function splitQuestions(request: SystemOneRequest<Questions>, limit: number): SystemOneRequest<Questions>[] {
  const questions = request.questions as Record<string, unknown>;
  const entries = questions && typeof questions === "object" && !Array.isArray(questions) ? Object.entries(questions) : undefined;
  // Anything that is not a plain question map, or that already fits, is one chunk and is validated later.
  if (!entries || entries.length <= limit) return [request];
  const chunks: SystemOneRequest<Questions>[] = [];
  for (let index = 0; index < entries.length; index += limit) {
    const questions = Object.fromEntries(entries.slice(index, index + limit));
    chunks.push({ ...request, questions } as SystemOneRequest<Questions>);
  }
  return chunks;
}

/**
 * Ask any number of questions about one state: chunk to the client's question limit, or the caller's `maxQuestions`
 * when smaller, fan out, and merge the answers, usage, and model. Use this when one coherent state carries many
 * independent questions; use `evaluate` for one request.
 */
export async function evaluateAll<Q extends Questions>(
  client: TypeSafe,
  request: SystemOneRequest<Q>,
  options: BatchOptions & { maxQuestions?: number } = {},
): Promise<BatchEvaluation<Q>> {
  const limit = chunkSize(options.maxQuestions, (client.limits ?? DEFAULT_BACKEND_LIMITS).maxQuestions);
  const chunks = splitQuestions(request as SystemOneRequest<Questions>, limit) as SystemOneRequest<Q>[];
  return evaluateMany(client, chunks, options);
}
