import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { Questions } from "@typesafe-ai/sdk";
import { createTypeSafe, DEFAULT_MAX_REQUESTS } from "./client.js";
import type { Evaluation, TypeSafe } from "./client.js";
import { clearStoredApiKey, credentialsPath, keySituation, keySourceLabel } from "./credentials.js";
import { TypeSafeIntegrationError, safeError } from "./errors.js";
import { loginWithPrompt } from "./login.js";
import { DEFAULT_MAX_INPUT_BYTES, evaluationSchema, normalizeEvaluationRequest, prepareEvaluationRequest } from "./schema.js";

const disclosure = "Submitted state and questions will be sent to api.typesafe.ai and may incur charges. Do not include secrets. The extension does not collect files or conversation history. Results are model judgments, not proof or authorization.";
const sample = {
  state: { message: "I was charged twice for my subscription. Please help today." },
  questions: {
    category: { type: "choice", instructions: "Which team should handle this message?", criteria: { billing: "Charges and payments", technical: "Software failures", other: "None of these" } },
    urgent: { type: "noul", instructions: "Does the sender request help today?" },
    frustration: { type: "score", instructions: "How frustrated does the sender sound?", criteria: ["A neutral request without expressed frustration", "Expressed frustration while remaining civil", "Explicit anger or threats"] },
  },
};

function format(result: Evaluation<Questions>, expanded = false): string {
  const lines = [`TypeSafe · ${JSON.stringify(result.model)} · ${result.elapsedMs} ms`];
  for (const [id, answer] of Object.entries(result.answers)) {
    const label = JSON.stringify(id);
    if (answer.type === "noul") lines.push(`${label}: P(yes) = ${answer.noul.toFixed(3)}`);
    else if (answer.type === "choice") lines.push(`${label}: ${JSON.stringify(answer.choice)} · confidence ${answer.confidence.toFixed(3)}`);
    else lines.push(`${label}: ${answer.score.toFixed(3)} · confidence ${answer.confidence.toFixed(3)}`);
    if (expanded && answer.type !== "noul") lines.push(`  ${JSON.stringify(answer.probabilities)}`);
  }
  lines.push(`${result.usage.input_tokens} input / ${result.usage.output_tokens} output tokens`);
  lines.push("Confidence is distribution concentration, not proof of correctness.");
  return lines.join("\n");
}

/** Native Pi registration; importing the root library does not load this module. */
export default function typesafeExtension(pi: ExtensionAPI): void {
  let enabled = process.env.PI_TYPESAFE_ENABLED === "1";
  let client: TypeSafe | undefined;
  const getClient = () => client ??= createTypeSafe();

  pi.on("session_start", async () => {
    enabled = process.env.PI_TYPESAFE_ENABLED === "1";
    client = undefined;
  });

  pi.registerEntryRenderer<Evaluation<Questions>>("typesafe-result", (entry, { expanded }) => new Text(entry.data ? format(entry.data, expanded) : "TypeSafe · no result", 0, 0));

  pi.registerTool({
    name: "typesafe_evaluate",
    label: "TypeSafe",
    description: `Evaluate supplied state with independent Choice, Score, and Noul questions in one TypeSafe request. Each question judges the whole state, so when several items are involved, put each item in a named state field (e.g. \`reports.r1\`) and ask one question per item per dimension (e.g. \`r1_owner\`, \`r2_owner\`), naming the field in the instructions; never aggregate several items into one question. ${disclosure} Requires operator opt-in via /typesafe enable or PI_TYPESAFE_ENABLED=1. Limit: 32 questions, ${DEFAULT_MAX_INPUT_BYTES / 1024} KiB JSON, ${DEFAULT_MAX_REQUESTS} attempts per session; no retries.`,
    promptSnippet: "Ask batched structured questions with TypeSafe (external service; operator opt-in required)",
    promptGuidelines: [
      "Use typesafe_evaluate only for requested semantic judgments, not calculations or exact lookups; send only the relevant permitted data.",
      "Batch independent typesafe_evaluate questions over the same state; use code or explicit permission rules for actions, never confidence as authorization.",
      "When typesafe_evaluate judges several items, give each item a named state field and ask one question per item per dimension, naming the field in the instructions; one question over many items returns an unusable blend.",
      "Report typesafe_evaluate answers as the model's judgments with their probabilities; do not replace them with your own guesses, and say when an answer is uncertain.",
    ],
    parameters: evaluationSchema,
    // Pi validates against `parameters` after this hook; the cast only names the schema's type.
    prepareArguments: args => normalizeEvaluationRequest(args) as Static<typeof evaluationSchema>,
    async execute(_id, params, signal) {
      if (!enabled) throw new TypeSafeIntegrationError("configuration", "TypeSafe is disabled. Ask the operator to run /typesafe enable; do not enable it by editing configuration or environment files.");
      // The tool admits through the same rule as the library; evaluate() re-runs it idempotently.
      const request = prepareEvaluationRequest(params);
      const result = await getClient().evaluate(request, signal ? { signal } : {});
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
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
      const matches = actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const action = args.trim() || "status";
      const report = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else pi.sendMessage({ customType: "typesafe-status", content: text, display: true });
      };
      try {
        if (action === "status") {
          const usage = client?.getUsage();
          const situation = keySituation();
          const key = situation.kind === "missing" ? "missing (run /typesafe login)"
            : situation.kind === "unusable" ? `unusable (${situation.reason})`
            : `from ${keySourceLabel(situation)}`;
          report(`TypeSafe: ${enabled ? "enabled" : "disabled"}; key ${key}; ${usage?.requestsStarted ?? 0}/${DEFAULT_MAX_REQUESTS} attempts; ${usage?.requestsSucceeded ?? 0} successful; ${usage?.inputTokens ?? 0} input tokens. Model: jev-latest. Limits reset on session start/reload. ${disclosure}`);
          return;
        }
        if (action === "logout") {
          const removed = clearStoredApiKey();
          client = undefined;
          enabled = false;
          report(removed ? `Removed the stored key at ${credentialsPath()}. TypeSafe is disabled.` : "No stored key to remove." + (process.env.TYPESAFE_API_KEY?.trim() ? " TYPESAFE_API_KEY is still set in the environment." : ""));
          return;
        }
        if (action === "disable") {
          enabled = false;
          report("TypeSafe disabled for future agent calls. In-flight requests are not cancelled.");
          return;
        }
        if (!actions.includes(action)) {
          report(`Usage: /typesafe ${actions.join(" | ")}`, "warning");
          return;
        }
        if (!ctx.hasUI) {
          report("This command needs interactive Pi. For headless tool use, explicitly set PI_TYPESAFE_ENABLED=1 and TYPESAFE_API_KEY before launching Pi.", "warning");
          return;
        }
        const situation = keySituation();
        if (action === "login" || (action === "setup" && situation.kind === "missing")) {
          if (process.env.TYPESAFE_API_KEY?.trim()) {
            report("TYPESAFE_API_KEY is set in the environment and takes precedence over a stored key. Unset it before using /typesafe login.", "warning");
            return;
          }
          const login = await loginWithPrompt(ctx);
          if (login === undefined) { report("Login cancelled; nothing was saved."); return; }
          client = undefined;
          report(`Key verified (${login.models} model${login.models === 1 ? "" : "s"} available) and saved to ${login.path} with owner-only permissions. Run /typesafe enable to allow agent tool calls.`);
          return;
        }
        if (action === "setup") {
          const current = situation.kind === "environment" || situation.kind === "stored" ? `configured via ${keySourceLabel(situation)}`
            : situation.kind === "unusable" ? `unusable — ${situation.reason}`
            : "missing";
          report(`Key ${current}. Run /typesafe test for one sample request or /typesafe enable to allow agent tool calls.`);
          return;
        }
        if (action === "enable") {
          if (situation.kind === "missing") { report("Run /typesafe login first: no API key is configured.", "warning"); return; }
          if (situation.kind === "unusable") { report(`The stored key cannot be used. ${situation.reason}`, "warning"); return; }
          if (await ctx.ui.confirm("Enable TypeSafe for this session?", disclosure)) {
            enabled = true;
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
        if (!await ctx.ui.confirm("Send this TypeSafe request?", disclosure)) return;
        const result = await getClient().evaluate(validated);
        // Playground results stay out of LLM context; the agent tool returns its own results normally.
        pi.appendEntry("typesafe-result", result);
      } catch (error) {
        report(safeError(error).message, "error");
      }
    },
  });
}
