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
| `apiKey` | the backend's key (below) | Never returned |
| `backend` | `typesafe` | `typesafe`, `openrouter`, `commandcode`, `liquid`, or a caller-supplied endpoint object; picks the host, the request path, the default model, and the key |
| `model` | `jev-latest` (`typesafe/jev-1.13` on OpenRouter, `typesafe/jev` on Command Code, `d1:free` on Liquid AI) | No model is inferred from submitted content |
| `timeoutMs` | `15000` | Per request; no automatic retries. Liquid's `d1:free` is slow: see below |
| `maxInputBytes` | `65536` | UTF-8 JSON bytes, not tokens |
| `maxRequests` | `20` | Attempts per client instance, failures included |
| `maxRequestsPerDay`, `maxInputTokensPerDay`, `maxUsdPerDay` | none | Local-day caps, persisted |
| `usdPerMTok` | the backend's price for the model sent, else `0.042` | Price in USD per million input tokens for the estimate and the USD cap; `0` means free. A value you pass wins over the backend's price |
| `ledger` | the store next to the key | Inject a ledger in tests |
| `fetch` | global fetch | Inject a transport for offline tests |

A `model` is mapped to the backend's own id form before it is sent: on OpenRouter a bare `jev-latest` goes as `~typesafe/jev-latest` and a bare `jev-1.13` (or `jev-1.13.0`) as `typesafe/jev-1.13`, while an id that already carries an author, such as `vendor/other`, passes unchanged, and TypeSafe sends ids as written. The same mapping applies to a per-request `model` inside `evaluate()`; the limits of 1–100 characters apply to your own id, before mapping. A caller-supplied endpoint's model is never mapped: `defaultModel` and a per-request `model` go on the wire as the caller wrote them.

`DECISIONS_BACKENDS` is the registry behind `backend`: `typesafe`, `openrouter`, `commandcode`, and `liquid`. Command Code serves the same Jev decisions protocol at `api.commandcode.ai` under `/provider/v1/systemone`, with the model id `typesafe/jev`; its model list is public, under `/provider/v1/models`, and arrives in `data` with ids in `id`. Each entry carries `label`, `host`, `keyEnv`, and, when the service does not serve the SDK's own paths, `path` for the judgment request plus `modelsPath`, `modelsField`, and `modelsIdField` for the model list — OpenRouter's and Command Code's lists are renamed to the `models` the SDK reads, with each entry's `id` promoted to the `name` that `listModels()` returns. `modelsVerifyKey: false` marks a backend whose model list is public, and therefore proves nothing about the key: both OpenRouter and Command Code serve theirs without checking one, so `listModels()` there leaves the auth state unverified while the answer check is unchanged and a malformed reply stays a `response` error. `DEFAULT_BACKEND` is `"typesafe"`.

Liquid AI (`liquid`) serves the same protocol at `api.liquid.ai` under `/decisions/v1/systemone`, with the key from `LIQUID_API_KEY` sent as a bearer token. Its model list, under `/decisions/v1/models`, uses the SDK's own `models` and `name` fields and checks the key (`modelsVerifyKey: true`), so `listModels()` there verifies it. Model ids go to Liquid unchanged. The default model is `d1:free` (free, 32,000 tokens per question); pass `model: "d1"` for the paid model (65,536 tokens per question). A registry entry may carry `prices`, USD per million input tokens by the model id as sent; `liquid` names `d1` at `0.040` and `d1:free` at `0`. A client with no `usdPerMTok` from you prices each request at its backend's price for the model it sends, and at `0.042` when the backend names no price for that model. `backendPrice(backend, model)` returns that registry price.

Liquid counts the state once per question, where TypeSafe counts it once per request. A request with N questions about one state therefore costs Liquid about N times the state: the same state of about 4,000 tokens with 3 questions was 4,301 input tokens on TypeSafe and 11,918 on Liquid.

Speed, measured on 2026-10-03 with one request at a time: `d1:free` took a median of about 14 seconds and sometimes failed with HTTP 504 after about 46 seconds; `d1` took about 0.5 seconds. With `d1:free`, raise `timeoutMs` above its 15-second default, or pass `model: "d1"`.

`backend` also accepts a caller-supplied endpoint object (`BackendEndpoint`) wherever a backend name is accepted — `createTypeSafe`, `keySituation`, `resolveApiKey`, `authState`, `ensureApiKey`, and `safeError`. An endpoint names `label`, `host`, and `keyEnv`, and optionally `path`, `modelsPath`, `modelsField`, `modelsIdField`, `modelsVerifyKey`, and `defaultModel`; it is validated on every call, never added to the registry, and without `defaultModel` requires `model` on `createTypeSafe`. `resolveBackend(nameOrEndpoint)` resolves either form to the validated `ResolvedBackend` the client uses (registry `name` when there is one, `host` as origin only, explicit `keyEnv` and `modelsVerifyKey`), and `backendHost(nameOrEndpoint)` returns just the destination host — `api.commandcode.ai`, `gw.example.com:8443` — for consent text. Validation is in this order, and every failure is a `configuration` error whose message never quotes a caller value (a host can carry credentials in its user info), except the label after it is validated:

| Rule | Refusal |
| --- | --- |
| `label` is a string, trimmed nonempty, at most 60 characters | `Backend label must be a nonempty string of at most 60 characters.` |
| `host` is an absolute `https:` URL with no user info, path, query, or fragment (`http:` only for a loopback host) | `Backend host must be an absolute https: URL with no user info, path, query, or fragment …` |
| `path`, when present, starts with `"/"` and carries no `?` or `#` | `Backend path must be a string that starts with "/".` |
| `modelsPath`, same rule | `Backend modelsPath must be a string that starts with "/".` |
| `modelsField` / `modelsIdField`, when present, nonempty strings | `Backend modelsField must be a nonempty string.` / `Backend modelsIdField must be a nonempty string.` |
| `modelsVerifyKey`, when present, a boolean | `Backend modelsVerifyKey must be a boolean.` |
| `keyEnv` is a name of letters, digits, and underscores, not starting with a digit | `Backend keyEnv must name an environment variable: letters, digits, and underscores, not starting with a digit.` |
| `keyEnv` is not `TYPESAFE_API_KEY` in any case | `Backend keyEnv must not be TYPESAFE_API_KEY: the TypeSafe key is only sent to the typesafe backend. Give this endpoint its own variable.` |
| `defaultModel`, when present, trimmed nonempty, at most 100 characters | `Backend defaultModel must be a nonempty string of at most 100 characters.` |

Anything that is neither a registry name nor such an object is refused with `backend must be a registry name or a backend object.`

The TypeSafe backend takes its key from `TYPESAFE_API_KEY`, then the `/typesafe login` store. Every other backend — registry or endpoint — reads only its own `keyEnv` variable: the store holds a TypeSafe key, and a login verifies against api.typesafe.ai, so neither applies elsewhere, and the TypeSafe key is only ever sent to the typesafe backend. `createTypeSafe` with no `apiKey` and no key in the backend's variable fails with `No API key. Set <keyEnv> in the environment.` before any request is built. Pass the same `backend` to `authState`, `keySituation`, and `ensureApiKey` so what you report matches what you send.

`evaluate(request, { signal })` validates before sending and rejects with `TypeSafeIntegrationError`. `code` is one of `configuration`, `validation`, `budget`, `aborted`, `timeout`, `http`, `connection`, `response`; messages never contain upstream bodies, keys, or your submitted state, and no header value except a numeric `Retry-After` count in seconds (quoted by the 429 advice as `Retry after <n> seconds.`). The advice is backend-aware: a 401 names the backend's own key variable (`Check TYPESAFE_API_KEY.`, `Check OPENROUTER_API_KEY.`, `Check COMMANDCODE_API_KEY.`, or `Check <keyEnv>.` for an endpoint), and a 402 says `Check your account balance.` except on OpenRouter, which says `Insufficient credits. Add credits at https://openrouter.ai/credits.` `listModels()` verifies the key without counting toward `maxRequests`, except on a backend whose model list is public (`modelsVerifyKey: false`, or an endpoint that does not set `modelsVerifyKey: true`), which accepts any key and leaves the auth state unverified.

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

The environment may lower an explicit cap, never raise it. A reached cap raises a `budget` error that names the cap, the amount used, and the day, before anything is submitted. Cost is estimated from input tokens only, because output is free. Each request is priced when it is recorded, at its own model's price, so one ledger can hold requests to backends and models with different prices and the day's spend, and the `maxUsdPerDay` cap, add up what each request cost; requests to a free model add nothing. A ledger file written before costs were recorded keeps working: days without a recorded cost are estimated at the ledger's `usdPerMTok` (default `0.042`).

`openUsageLedger(options)`, `usagePath()`, `estimateUsd(tokens, usdPerMTok)`, `capsFromEnvironment(env)`, and `mergeCaps(explicit, environment)` expose the same arithmetic for your own display.

## Auth state

`authState({ backend })` never throws for a valid backend. An invalid backend — an unknown name or an endpoint object that fails validation — throws the same `configuration` error as `resolveBackend`, so validate a user-supplied endpoint with `resolveBackend` first. It reports `backend` (the value you passed, `typesafe` by default — a name or your endpoint object), `kind` (`environment`, `stored`, `missing`, `unusable`), `keyName`, `path`, `reason`, `verified`, `verifiedAt`, `lastFailure`, and `usable` — `usable` is false when no key is present or the last authentication outcome was an HTTP 401/403 rejection. Name the backend you pass to `createTypeSafe`, or the report describes a key you do not send. The verification and failure record is one file shared by every backend, so after switching backends the last outcome stands until the next request: a 401 recorded while one backend is in use makes every backend's `authState` report `usable: false`.

`describeAuth(state)` turns that into `{ level: "ok" | "warning" | "error", text }` for a status line or a log. The extension calls both at session start and after a rejection, so an enabled-but-unusable setup is never reported as working.

`recordAuthVerified()` is called by `listModels()` and by the first successful request; `recordAuthFailure(error)` records what degraded TypeSafe; `clearAuthState()` forgets both, and `/typesafe logout` calls it. `keySituation(backend)` and `keySourceLabel(situation)` remain the lower-level, frozen-for-existing-callers pair, and `resolveApiKey(backend)` the pre-0.4.0 one; the `backend` argument is optional and defaults to `typesafe`. An environment situation names the variable it read in `keyEnv`.

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

`ensureApiKey(ctx, { backend })`, `loginWithPrompt(ctx)`, and `promptForApiKey(ctx)` use the same hidden input as `/typesafe login`. `ensureApiKey(ctx)` returns the existing key source, or prompts, verifies, and stores a new TypeSafe key (`undefined` when the user cancels). For any other backend it returns the environment source or throws `configuration` naming the variable to set; it never opens the prompt, because the prompt verifies against api.typesafe.ai and writes the TypeSafe store. These need Pi's TUI, so call them only from extension command handlers.

## One agent tool

`typesafe_evaluate` is the only tool the package registers. It already accepts typed Choice, Score, and Noul questions, including the aliases above, so a separate "ask Jev" tool would duplicate the admission seam and give the model two ways to do one thing. `ask()` is the author-facing half of that seam; both run through `prepareEvaluationRequest`, so what one accepts the others accept.

Your extension owns its own user consent and budget; `/typesafe enable` applies only to this package's tool. See [`../examples/decision-extension.ts`](../examples/decision-extension.ts) and [pi-warden](https://github.com/DevMortimer/pi-warden) for a full extension built this way.
