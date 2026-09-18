# API

Everything `pi-typesafe` exports, for extension authors. The library has no dependency on Pi's runtime and is safe in tests. The README covers the tool, the commands, and how to write questions.

## The client

```ts
import { createTypeSafe, choice, noul, score } from "pi-typesafe";

const typesafe = createTypeSafe({ maxRequests: 5, maxUsdPerDay: 1 });
const result = await typesafe.evaluate({
  state: { title: "Login fails after update", body: "..." },
  questions: {
    area: choice("Which area does this report concern?", { auth: "Sign-in", ui: "Layout", other: null }),
    duplicate: noul("Does the report describe the same defect as `known_issue`?"),
    severity: score("How severe is the defect?", ["Cosmetic", "Workaround exists", "Blocking"]),
  },
});
result.answers.area.choice;      // "auth" | "ui" | "other"
result.answers.duplicate.noul;   // 0..1
result.answers.severity.score;   // 0..2, may be fractional
```

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY`, else the `/typesafe login` store | Never returned |
| `model` | `jev-latest` | No model is inferred from submitted content |
| `timeoutMs` | `15000` | Per request; no automatic retries |
| `maxInputBytes` | `65536` | UTF-8 JSON bytes, not tokens |
| `maxRequests` | `20` | Attempts per client instance, failures included |
| `maxRequestsPerDay`, `maxInputTokensPerDay`, `maxUsdPerDay` | none | Local-day caps, persisted |
| `usdPerMTok` | `0.042` | Price used for the estimate and the USD cap |
| `ledger` | the store next to the key | Inject a ledger in tests |
| `fetch` | global fetch | Inject a transport for offline tests |

`evaluate(request, { signal })` validates before sending and rejects with `TypeSafeIntegrationError`. `code` is one of `configuration`, `validation`, `budget`, `aborted`, `timeout`, `http`, `connection`, `response`; messages never contain upstream bodies, headers, keys, or your submitted state. `listModels()` verifies the key without counting toward `maxRequests`.

## Admission

`prepareEvaluationRequest(value, { maxInputBytes })` is the one admission rule, used by the tool, the playground, and `evaluate`. It normalizes the near-miss aliases a model produces (`options` / `levels` / `choices` for `criteria`, a string Noul criterion, a label array for a Choice), validates the schema and JSON-safety, then enforces the byte budget. `DEFAULT_MAX_INPUT_BYTES`, `DEFAULT_MAX_QUESTIONS`, and `DEFAULT_MAX_REQUESTS` hold the shared defaults.

## Batching

`evaluate` is one request: up to 32 questions about one state. Both batching calls preserve input order, bound concurrency (`concurrency`, default 4), never throw, and stop submitting once a `budget` or cancellation failure appears.

| Call | Use |
| --- | --- |
| `evaluateAll(request)` | One state, any number of questions: chunks over 32 share the state, then merge into one `answers` map with usage summed |
| `evaluateMany(requests)` | Several requests: per-request results plus merged answers, `failures`, `skipped` |
| `chunkEvaluationRequest(request, { maxQuestions })` | The splitter alone; a pure function, no validation |
| `fanOut(items, worker, { concurrency, signal, stopOn })` | The pool underneath, for your own work |

Every item comes back as `{ ok: true, index, value }` or `{ ok: false, index, error, skipped }`; `skipped` marks work that was never submitted.

## Usage and spend

`getUsage()` returns this client's session counters (`requestsStarted`, `requestsSucceeded`, `requestsFailed`, `inputTokens`, `outputTokens`, `estimatedUsd`). `getSpend()` adds today's persisted totals, the caps in force, and the cap currently reached.

Day caps live in `~/.pi/agent/pi-typesafe/usage.json` (owner-only, atomic, best-effort: an unwritable ledger never fails a request) and roll over at local midnight.

| Option | Environment | Bounds |
| --- | --- | --- |
| `maxRequestsPerDay` | `PI_TYPESAFE_MAX_REQUESTS_PER_DAY` | requests |
| `maxInputTokensPerDay` | `PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY` | input tokens |
| `maxUsdPerDay` | `PI_TYPESAFE_MAX_USD_PER_DAY` | estimated spend |

The environment may lower an explicit cap, never raise it. A reached cap raises a `budget` error that names the cap, the amount used, and the day, before anything is submitted. Cost is estimated from input tokens only, because output is free.

`openUsageLedger(options)`, `usagePath()`, `estimateUsd(tokens, usdPerMTok)`, `capsFromEnvironment(env)`, and `mergeCaps(explicit, environment)` expose the same arithmetic for your own display.

## Auth state

`authState()` never throws. It reports `kind` (`environment`, `stored`, `missing`, `unusable`), `keyName`, `path`, `reason`, `verified`, `verifiedAt`, `lastFailure`, and `usable` — `usable` is false when no key is present or the last authentication outcome was an HTTP 401/403 rejection.

`describeAuth(state)` turns that into `{ level: "ok" | "warning" | "error", text }` for a status line or a log. The extension calls both at session start and after a rejection, so an enabled-but-unusable setup is never reported as working.

`recordAuthVerified()` is called by `listModels()` and by the first successful request; `recordAuthFailure(error)` records what degraded TypeSafe; `clearAuthState()` forgets both, and `/typesafe logout` calls it. `keySituation()` and `keySourceLabel(situation)` remain the lower-level, frozen-for-existing-callers pair, and `resolveApiKey()` the pre-0.4.0 one.

## Asking without throwing

```ts
import { ask } from "pi-typesafe";

const answer = await ask(typesafe, request, { timeoutMs: 5_000, signal: mySignal });
if (!answer.ok) return { skipped: answer.errorCode === "budget" };
answer.answers; // typed, plus model, usage, elapsedMs
```

`ask` merges its deadline into your signal, takes any object with `evaluate` (so tests pass a stub), and never throws: a failure is `{ ok: false, error, errorCode }` with pi-typesafe's own message. Unknown failures become a fixed message, so nothing from the transport reaches the user.

## Calibration: `pi-typesafe/calibrate`

A small, domain-free toolkit for turning labelled cases into thresholds.

```ts
import { calibrate, formatCalibration, replay, samplesOf } from "pi-typesafe/calibrate";

const results = await replay(cases, data => scoreOne(data), { concurrency: 6 });
console.log(formatCalibration(calibrate("action guard", samplesOf(results).samples, { minPrecision: 0.8 })));
```

| Export | Purpose |
| --- | --- |
| `auc(samples)` | Rank-based AUC (Mann–Whitney, ties count half); undefined when one class is empty |
| `metricsAt(samples, threshold)`, `sweep(samples, thresholds)` | Confusion counts plus precision, recall, and flag rate |
| `defaultThresholds(samples)`, `pickThreshold(rows, floors)` | The distinct-score grid, and the lowest threshold that clears a precision and recall floor |
| `calibrate(name, samples, options)`, `formatCalibration(calibration)` | AUC, the sweep, a recommendation, and what it misses and flags, as text |
| `replay(cases, score, options)`, `samplesOf(results)` | Run labelled cases through any scorer with bounded concurrency, keep per-case failures, then extract the scored samples |

`replay` stops on a `budget` failure like the batching calls, and reports each failure with the scorer's own message unless you pass `describeError`.

## Login helpers: `pi-typesafe/ui`

`ensureApiKey(ctx)`, `loginWithPrompt(ctx)`, and `promptForApiKey(ctx)` use the same hidden input as `/typesafe login`. `ensureApiKey(ctx)` returns the existing key source, or prompts, verifies, and stores a new key (`undefined` when the user cancels). These need Pi's TUI, so call them only from extension command handlers.

## One agent tool

`typesafe_evaluate` is the only tool the package registers. It already accepts typed Choice, Score, and Noul questions, including the aliases above, so a separate "ask Jev" tool would duplicate the admission seam and give the model two ways to do one thing. `ask()` is the author-facing half of that seam; both run through `prepareEvaluationRequest`, so what one accepts the others accept.

Your extension owns its own user consent and budget; `/typesafe enable` applies only to this package's tool. See [`../examples/decision-extension.ts`](../examples/decision-extension.ts) and [pi-warden](https://github.com/DevMortimer/pi-warden) for a full extension built this way.
