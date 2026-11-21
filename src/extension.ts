import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { Questions } from "@typesafe-ai/sdk";
import { BACKEND_ENV, DEFAULT_BACKEND, DECISIONS_BACKENDS, MODEL_ENV, backendFromEnvironment, backendHost, modelFromEnvironment, resolveBackend, sentModelId } from "./backends.js";
import type { ResolvedBackend, TypeSafeBackend } from "./backends.js";
import { createTypeSafe, DEFAULT_MAX_REQUESTS } from "./client.js";
import type { Evaluation, SpendReport, TypeSafe } from "./client.js";
import { authState, clearAuthState, describeAuth, isKeyRejection } from "./auth.js";
import type { AuthReport, AuthState } from "./auth.js";
import { clearStoredApiKey, credentialsPath } from "./credentials.js";
import { TypeSafeIntegrationError, safeError } from "./errors.js";
import { loginWithPrompt } from "./login.js";
import { DEFAULT_MAX_INPUT_BYTES, evaluationSchema, normalizeEvaluationRequest, prepareEvaluationRequest } from "./schema.js";

const fixedDisclosure = "Submitted state and questions will be sent to api.typesafe.ai and may incur charges. Do not include secrets. The extension does not collect files or conversation history. Results are model judgments, not proof or authorization.";

export interface RouteConsent {
  readonly text: string;
  readonly namesModel: boolean;
}

export interface ValidSessionRoute {
  readonly status: "valid";
  readonly backend: TypeSafeBackend;
  readonly config: ResolvedBackend;
  readonly model: string | undefined;
  readonly sentModel: string;
  readonly consent: RouteConsent;
}

export interface InvalidSessionRoute {
  readonly status: "invalid";
  readonly error: string;
}

export type SessionRoute = ValidSessionRoute | InvalidSessionRoute;

export type ConsentSource = "environment" | "command";

export type ConsentState =
  | { readonly status: "disabled" }
  | { readonly status: "enabled"; readonly source: ConsentSource };

export type ConsentEvent =
  | { readonly type: "session_start"; readonly envEnabled: boolean }
  | { readonly type: "enable" }
  | { readonly type: "disable" }
  | { readonly type: "logout"; readonly isActive: boolean; readonly hasEnvKey: boolean };

export type CalloutState =
  | { readonly status: "healthy" }
  | { readonly status: "degraded"; readonly key: string };

export type CalloutEvent =
  | { readonly type: "session_start" }
  | { readonly type: "login_succeeded" }
  | { readonly type: "evaluate_succeeded" }
  | { readonly type: "degrade"; readonly key: string };

export interface CalloutTransition {
  readonly state: CalloutState;
  readonly emit: boolean;
}

export interface BudgetBlock {
  readonly reason: "session_cap" | "daily_cap";
  readonly message: string;
}

export type SessionReadiness =
  | { readonly status: "invalid_backend"; readonly error: string }
  | { readonly status: "disabled"; readonly route: ValidSessionRoute; readonly auth: AuthState; readonly authReport: AuthReport; readonly budget?: BudgetBlock }
  | { readonly status: "blocked_auth"; readonly route: ValidSessionRoute; readonly auth: AuthState; readonly authReport: AuthReport; readonly budget?: BudgetBlock }
  | { readonly status: "blocked_budget"; readonly route: ValidSessionRoute; readonly auth: AuthState; readonly authReport: AuthReport; readonly budget: BudgetBlock }
  | { readonly status: "ready"; readonly route: ValidSessionRoute; readonly auth: AuthState; readonly authReport: AuthReport };

export interface ReadinessInput {
  readonly route: SessionRoute;
  readonly consent: ConsentState;
  readonly auth?: AuthState | undefined;
  readonly spend?: SpendReport | undefined;
  readonly maxRequests?: number | undefined;
}

/**
 * The consent sentence for the backend this session actually uses, and whether it names the model sent. The default
 * backend with no model override returns the fixed sentence unchanged, so an install that selects nothing reads
 * exactly what it read before. Every other session is told the host, the backend, and the model id the request
 * carries — the same `sentModelId` value the client sends, so consent cannot describe a model that is not sent.
 */
function consentFor(backend: TypeSafeBackend, model: string | undefined): RouteConsent {
  const namesModel = backend !== DEFAULT_BACKEND || model !== undefined;
  if (!namesModel) return { text: fixedDisclosure, namesModel };
  const config = resolveBackend(backend);
  return {
    text: `Submitted state and questions will be sent to ${backendHost(backend)} (${config.label}) as model ${JSON.stringify(sentModelId(backend, model))} and may incur charges. Do not include secrets. The extension does not collect files or conversation history. Results are model judgments, not proof or authorization.`,
    namesModel,
  };
}

/** Parse route once at load so an invalid PI_TYPESAFE_BACKEND carries no backend id and cannot fall back to api.typesafe.ai. */
export function resolveSessionRoute(env: NodeJS.ProcessEnv = process.env): SessionRoute {
  try {
    const backend = backendFromEnvironment(env);
    const model = modelFromEnvironment(env);
    const config = resolveBackend(backend);
    const sentModel = sentModelId(backend, model);
    return {
      status: "valid",
      backend,
      config,
      model,
      sentModel,
      consent: consentFor(backend, model),
    };
  } catch (error) {
    return { status: "invalid", error: safeError(error).message };
  }
}

export function initialConsent(env: NodeJS.ProcessEnv = process.env): ConsentState {
  return env.PI_TYPESAFE_ENABLED === "1"
    ? { status: "enabled", source: "environment" }
    : { status: "disabled" };
}

export function transitionConsent(state: ConsentState, event: ConsentEvent): ConsentState {
  switch (event.type) {
    case "session_start":
      return event.envEnabled ? { status: "enabled", source: "environment" } : { status: "disabled" };
    case "enable":
      return { status: "enabled", source: "command" };
    case "disable":
      return { status: "disabled" };
    case "logout":
      // Removing a shadowed or non-active backend key does not invalidate the session's active credentials.
      return event.isActive && !event.hasEnvKey ? { status: "disabled" } : state;
  }
}

/** Deduplicate repeated callouts while degraded, and re-arm on session start or recovery so later degradations still surface. */
export function transitionCallout(state: CalloutState, event: CalloutEvent): CalloutTransition {
  switch (event.type) {
    case "session_start":
    case "login_succeeded":
    case "evaluate_succeeded":
      return { state: { status: "healthy" }, emit: false };
    case "degrade":
      if (state.status === "degraded" && state.key === event.key) {
        return { state, emit: false };
      }
      return { state: { status: "degraded", key: event.key }, emit: true };
  }
}

/** Client getSpend().blocked covers daily caps only, so surface the per-session attempt cap explicitly here too. */
export function budgetBlockFor(spend: SpendReport | undefined, maxRequests = DEFAULT_MAX_REQUESTS): BudgetBlock | undefined {
  if (spend === undefined) return undefined;
  const sessionLimit = spend.caps.maxRequests ?? maxRequests;
  if (spend.session.requestsStarted >= sessionLimit) {
    return {
      reason: "session_cap",
      message: `Session cap reached: ${spend.session.requestsStarted}/${sessionLimit} attempts in this session; no request will be submitted until session start/reload.`,
    };
  }
  if (spend.blocked !== undefined) {
    return {
      reason: "daily_cap",
      message: `Cap reached: ${spend.blocked.cap} ${spend.blocked.used}/${spend.blocked.limit} on ${spend.blocked.day}; no request will be submitted until the local day rolls over.`,
    };
  }
  return undefined;
}

export function deriveSessionReadiness(input: ReadinessInput): SessionReadiness {
  if (input.route.status === "invalid") {
    return { status: "invalid_backend", error: input.route.error };
  }
  const auth = input.auth ?? authState({ backend: input.route.backend });
  const authReport = describeAuth(auth);
  const budget = budgetBlockFor(input.spend, input.maxRequests);
  if (input.consent.status === "disabled") {
    return { status: "disabled", route: input.route, auth, authReport, ...(budget === undefined ? {} : { budget }) };
  }
  if (authReport.level === "error") {
    return { status: "blocked_auth", route: input.route, auth, authReport, ...(budget === undefined ? {} : { budget }) };
  }
  if (budget !== undefined) {
    return { status: "blocked_budget", route: input.route, auth, authReport, budget };
  }
  return { status: "ready", route: input.route, auth, authReport };
}

/** The status line naming the backend, its host, and its key variable; the model is stated once, by `Model:` or the consent sentence. */
function backendLine(route: ValidSessionRoute): string {
  return `${route.config.label} backend: ${backendHost(route.backend)}, key from ${route.config.keyEnv}.`;
}
const sample = {
  state: { message: "I was charged twice for my subscription. Please help today." },
  questions: {
    category: { type: "choice", instructions: "Which team should handle this message?", criteria: { billing: "Charges and payments", technical: "Software failures", other: "None of these" } },
    urgent: { type: "noul", instructions: "Does the sender request help today?" },
    frustration: { type: "score", instructions: "How frustrated does the sender sound?", criteria: ["Neutral request", "Frustrated but civil", "Angry or threatening"] },
  },
};

/** 0.7.0 reports a count it did not measure as null; name it instead of printing "null". */
const formatNumber = (count: number | null): string => (count === null ? "not reported" : String(count));

function format(result: Evaluation<Questions>, expanded = false): string {
  const lines = [`TypeSafe · ${JSON.stringify(result.model)} · ${result.elapsedMs} ms`];
  for (const [id, answer] of Object.entries(result.answers)) {
    const label = JSON.stringify(id);
    if (answer.type === "noul") lines.push(`${label}: P(yes) = ${answer.noul.toFixed(3)}`);
    else if (answer.type === "choice") lines.push(`${label}: ${JSON.stringify(answer.choice)} · confidence ${answer.confidence.toFixed(3)}`);
    else if (answer.type === "score") lines.push(`${label}: ${answer.score.toFixed(3)} · confidence ${answer.confidence.toFixed(3)}`);
    else lines.push(`${label}: box ${JSON.stringify(answer.box)} · confidence ${formatNumber(answer.confidence)}`);
    if (expanded && (answer.type === "choice" || answer.type === "score")) lines.push(`  ${JSON.stringify(answer.probabilities)}`);
  }
  lines.push(`${formatNumber(result.usage.input_tokens)} input / ${formatNumber(result.usage.output_tokens)} output tokens`);
  lines.push("Confidence is distribution concentration, not proof of correctness.");
  return lines.join("\n");
}

/** Native Pi registration; importing the root library does not load this module. */
export default function typesafeExtension(pi: ExtensionAPI): void {
  // Resolved once per process: the backend names the host every request goes to, so it cannot change mid-session.
  const route = resolveSessionRoute();
  let consent = initialConsent();
  let client: TypeSafe | undefined;
  let callout: CalloutState = { status: "healthy" };
  const getClient = (valid: ValidSessionRoute): TypeSafe =>
    client ??= createTypeSafe({ backend: valid.backend, ...(valid.model === undefined ? {} : { model: valid.model }) });
  const callOut = (ctx: ExtensionContext | undefined, key: string, text: string) => {
    const next = transitionCallout(callout, { type: "degrade", key });
    callout = next.state;
    if (!next.emit) return;
    try {
      if (ctx?.hasUI) ctx.ui.notify(text, "warning");
      else pi.sendMessage({ customType: "typesafe-status", content: text, display: true });
    } catch {
      // Reporting must never replace the failure it describes, and a headless run may have no message channel.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    consent = transitionConsent(consent, { type: "session_start", envEnabled: process.env.PI_TYPESAFE_ENABLED === "1" });
    client = undefined;
    callout = transitionCallout(callout, { type: "session_start" }).state;
    // An enabled extension with no usable key used to look exactly like a working one. Say it at startup; an
    // unverified-but-present key stays quiet, because the first request is what proves it.
    const readiness = deriveSessionReadiness({ route, consent });
    if (readiness.status === "invalid_backend") {
      callOut(ctx, "start:backend", `${readiness.error} Judgments will fail until ${BACKEND_ENV} names a valid backend or is unset.`);
    } else if (readiness.status === "blocked_auth") {
      callOut(ctx, `start:${readiness.authReport.level}`, `TypeSafe is enabled but judgments will fail. ${readiness.authReport.text}`);
    }
  });

  pi.registerEntryRenderer<Evaluation<Questions>>("typesafe-result", (entry, { expanded }) => new Text(entry.data ? format(entry.data, expanded) : "TypeSafe · no result", 0, 0));

  pi.registerTool({
    name: "typesafe_evaluate",
    label: "TypeSafe",
    description: route.status === "valid"
      ? `Evaluate supplied state with independent Choice, Score, and Noul questions in one ${route.config.label} request. Each question judges the whole state, so when several items are involved, put each item in a named state field (e.g. \`reports.r1\`) and ask one question per item per dimension (e.g. \`r1_owner\`, \`r2_owner\`), naming the field in the instructions; never aggregate several items into one question. ${route.consent.text} Requires operator opt-in via /typesafe enable or PI_TYPESAFE_ENABLED=1. Limit: 32 questions, ${DEFAULT_MAX_INPUT_BYTES / 1024} KiB JSON, ${DEFAULT_MAX_REQUESTS} attempts per session; no retries.`
      : `Evaluate supplied state with TypeSafe. Unavailable: ${route.error} Fix or unset ${BACKEND_ENV} before calling this tool.`,
    promptSnippet: route.status === "valid"
      ? `Ask batched structured questions with ${route.config.label} (external service; operator opt-in required)`
      : `TypeSafe unavailable: invalid ${BACKEND_ENV} configuration`,
    promptGuidelines: [
      // The payload shape is what models get wrong on the first call; the same sample the playground edits is the cheapest way to show it.
      // Every session pays for this line on every tool listing, so the sample stays short.
      `Request shape, all three question kinds in one call: ${JSON.stringify(sample)}`,
      "Use typesafe_evaluate only for requested semantic judgments, not calculations or exact lookups; send only the relevant permitted data.",
      "Batch independent typesafe_evaluate questions over the same state; use code or explicit permission rules for actions, never confidence as authorization.",
      "When typesafe_evaluate judges several items, give each item a named state field and ask one question per item per dimension, naming the field in the instructions; one question over many items returns an unusable blend.",
      "Report typesafe_evaluate answers as the model's judgments with their probabilities; do not replace them with your own guesses, and say when an answer is uncertain.",
    ],
    parameters: evaluationSchema,
    // Pi validates against `parameters` after this hook; the cast only names the schema's type.
    prepareArguments: args => normalizeEvaluationRequest(args) as Static<typeof evaluationSchema>,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<Evaluation<Questions>>> {
      const readiness = deriveSessionReadiness({ route, consent, spend: client?.getSpend() });
      if (readiness.status === "invalid_backend") throw new TypeSafeIntegrationError("configuration", readiness.error);
      if (readiness.status === "disabled") throw new TypeSafeIntegrationError("configuration", "TypeSafe is disabled. Ask the operator to run /typesafe enable; do not enable it by editing configuration or environment files.");
      const validRoute = readiness.route;
      // The tool admits through the same rule as the library; evaluate() re-runs it idempotently.
      const request = prepareEvaluationRequest(params);
      try {
        const result = await getClient(validRoute).evaluate(request, signal ? { signal } : {});
        callout = transitionCallout(callout, { type: "evaluate_succeeded" }).state;
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const safe = safeError(error, validRoute.backend);
        // A 401 is about the key, so it outlives this call and is called out once; a 403 refuses one request and is
        // only thrown. The client recorded the failure before throwing, so describeAuth describes that failure.
        if (isKeyRejection(safe.status)) {
          const auth = describeAuth(authState({ backend: validRoute.backend }));
          callOut(ctx, `run:${safe.code}:${safe.status ?? ""}`, `${auth.text} Judgments will fail until the key is fixed.`);
        } else if (safe.code === "configuration") {
          callOut(ctx, "run:configuration", `${safe.message} Judgments will fail until that is fixed.`);
        }
        throw safe;
      }
    },
    renderCall(args) {
      return new Text(`TypeSafe · ${Object.keys(args.questions ?? {}).length} questions · external request`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }) {
      if (isPartial) return new Text("TypeSafe · waiting for response", 0, 0);
      if (!result.details?.answers) return new Text(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 0, 0);
      return new Text(format(result.details, expanded), 0, 0);
    },
  });

  const actions = ["login", "logout", "setup", "status", "enable", "disable", "test", "playground"];
  pi.registerCommand("typesafe", {
    description: "TypeSafe login, consent, usage, sample test, and JSON playground",
    getArgumentCompletions(prefix) {
      const [verb, ...rest] = prefix.split(/\s+/);
      if (rest.length && (verb === "login" || verb === "logout")) {
        const typed = rest.join(" ");
        const names = (Object.keys(DECISIONS_BACKENDS) as TypeSafeBackend[]).filter(name => name.startsWith(typed));
        return names.length ? names.map(name => ({ value: `${verb} ${name}`, label: name })) : null;
      }
      const matches = actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const backendArg = rest[0];
      const backendChoices = Object.keys(DECISIONS_BACKENDS).join(", ");
      const report = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else pi.sendMessage({ customType: "typesafe-status", content: text, display: true });
      };
      if (action === "disable") {
        consent = transitionConsent(consent, { type: "disable" });
        report("TypeSafe disabled for future agent calls. In-flight requests are not cancelled.");
        return;
      }
      if (!actions.includes(action)) {
        report(`Usage: /typesafe ${actions.join(" | ")}. login and logout take a backend name: ${backendChoices}.`, "warning");
        return;
      }
      if (action === "status") {
        const spend = client?.getSpend();
        const readiness = deriveSessionReadiness({ route, consent, spend });
        const session = spend
          ? `Session ${spend.session.requestsStarted}/${DEFAULT_MAX_REQUESTS} attempts, ${spend.session.requestsSucceeded} successful, ${spend.session.requestsFailed} failed, ${spend.session.inputTokens} input tokens (~$${spend.session.estimatedUsd.toFixed(4)}).`
          : `Session 0/${DEFAULT_MAX_REQUESTS} attempts; no client yet in this session.`;
        const today = spend
          ? `Today ${spend.today.requestsStarted} requests (${spend.today.requestsSucceeded} ok, ${spend.today.requestsFailed} failed), ${spend.today.inputTokens} input tokens, ~$${spend.today.estimatedUsd.toFixed(4)}.`
          : "";
        if (readiness.status === "invalid_backend") {
          report([
            `TypeSafe: ${consent.status}.`,
            `Backend: ${BACKEND_ENV} is invalid — ${readiness.error} Judgments will fail.`,
            session,
            "Session limits reset on session start/reload; daily counters persist and caps come from client options or PI_TYPESAFE_MAX_* environment variables.",
          ].join(" "), "warning");
          return;
        }
        const budget = readiness.status === "ready" ? undefined : readiness.budget;
        const version = !readiness.route.consent.namesModel ? `Model: ${readiness.route.sentModel}.` : "";
        report([
          `TypeSafe: ${consent.status}.`,
          backendLine(readiness.route),
          readiness.authReport.text,
          session,
          today,
          budget?.message ?? "",
          version,
          readiness.route.backend === DEFAULT_BACKEND ? "" : `Set ${MODEL_ENV} to send another model.`,
          "Session limits reset on session start/reload; daily counters persist and caps come from client options or PI_TYPESAFE_MAX_* environment variables.",
          readiness.route.consent.text,
        ].filter((part) => part !== "").join(" "), readiness.status === "blocked_auth" || readiness.status === "blocked_budget" ? "warning" : "info");
        return;
      }
      // Invalid route carries no backend id: decline every command that would touch keys, consent, or the API.
      if (route.status === "invalid") {
        if (action === "login" || action === "logout") {
          report(`${route.error} No key change fixes that, so /typesafe ${action} does nothing: fix or unset ${BACKEND_ENV} first.`, "warning");
        } else {
          report(`${route.error} /typesafe ${action} cannot run until ${BACKEND_ENV} names a valid backend or is unset.`, "warning");
        }
        return;
      }
      try {
        // A backend the command names, or this session's own backend when it names none, so the commands act on
        // what judgments actually use. resolveBackend refuses a name the registry does not know.
        const spec: TypeSafeBackend = backendArg === undefined ? route.backend : backendArg as TypeSafeBackend;
        const config = resolveBackend(spec);
        const isActive = config.keyEnv === route.config.keyEnv;
        if (action === "logout") {
          const removed = clearStoredApiKey(spec);
          const env = process.env[config.keyEnv]?.trim();
          if (isActive) {
            clearAuthState();
            client = undefined;
          }
          consent = transitionConsent(consent, { type: "logout", isActive, hasEnvKey: Boolean(env) });
          const tail = env
            ? ` ${config.keyEnv} is still set in the environment and takes precedence over a stored key.`
            : (isActive ? " Judgments are off for this session." : "");
          report(`${removed ? `Removed the stored ${config.label} key at ${credentialsPath()}.` : `No stored ${config.label} key to remove.`}${tail}`);
          return;
        }
        if (!ctx.hasUI) {
          report(`This command needs interactive Pi. For headless tool use, explicitly set PI_TYPESAFE_ENABLED=1 and ${config.keyEnv} before launching Pi.`, "warning");
          return;
        }
        const readiness = deriveSessionReadiness({ route, consent, spend: client?.getSpend() });
        if (readiness.status === "invalid_backend") {
          report(`${readiness.error} /typesafe ${action} cannot run until ${BACKEND_ENV} names a valid backend or is unset.`, "warning");
          return;
        }
        if (action === "login" || (action === "setup" && readiness.auth.kind === "missing")) {
          // The one rule for every backend: the stored key is used unless the backend's variable is set, and then it wins.
          if (process.env[config.keyEnv]?.trim()) {
            report(`${config.keyEnv} is set in the environment and takes precedence over a stored key. Unset it before using /typesafe login.`, "warning");
            return;
          }
          const login = await loginWithPrompt(ctx, { backend: spec });
          if (login === undefined) { report("Login cancelled; nothing was saved."); return; }
          if (isActive) {
            client = undefined;
            callout = transitionCallout(callout, { type: "login_succeeded" }).state;
          }
          const proof = login.models === undefined ? "verified with one request" : `verified (${login.models} model${login.models === 1 ? "" : "s"} available)`;
          const hint = isActive
            ? (consent.status === "enabled" ? "" : " Run /typesafe enable to allow agent tool calls.")
            : ` ${BACKEND_ENV} is ${route.backend}; set it to ${config.name} to send judgments there.`;
          report(`${config.label} key ${proof} and saved to ${login.path} with owner-only permissions.${hint}`);
          return;
        }
        if (action === "setup") {
          const current = readiness.auth.kind === "environment" || readiness.auth.kind === "stored" ? `configured via ${readiness.auth.keyName}`
            : readiness.auth.kind === "unusable" ? `unusable — ${readiness.auth.reason}`
            : "missing";
          const budget = readiness.status === "ready" ? undefined : readiness.budget;
          report(`Key ${current}. Run /typesafe test for one sample request or /typesafe enable to allow agent tool calls.${budget ? ` ${budget.message}` : ""}`, budget ? "warning" : "info");
          return;
        }
        if (action === "enable") {
          if (readiness.auth.kind === "missing") { report("Run /typesafe login first: no API key is configured.", "warning"); return; }
          if (readiness.auth.kind === "unusable") { report(`The stored key cannot be used. ${readiness.auth.reason}`, "warning"); return; }
          if (await ctx.ui.confirm("Enable TypeSafe for this session?", route.consent.text)) {
            consent = transitionConsent(consent, { type: "enable" });
            report(`TypeSafe enabled. Up to ${DEFAULT_MAX_REQUESTS} attempts in this session; /typesafe disable stops future agent calls.`);
          }
          return;
        }
        let request = sample;
        if (action === "playground") {
          const text = await ctx.ui.editor("TypeSafe request JSON · edit state and questions", JSON.stringify(sample, null, 2));
          if (text === undefined) return;
          try { request = JSON.parse(text); } catch { report("Invalid JSON. Keep quoted strings on one line; nothing was sent.", "error"); return; }
        }
        const validated = prepareEvaluationRequest(request);
        if (!await ctx.ui.confirm("Send this TypeSafe request?", route.consent.text)) return;
        const result = await getClient(route).evaluate(validated);
        callout = transitionCallout(callout, { type: "evaluate_succeeded" }).state;
        // Playground results stay out of LLM context; the agent tool returns its own results normally.
        pi.appendEntry("typesafe-result", result);
      } catch (error) {
        report(safeError(error, route.backend).message, "error");
      }
    },
  });
}
