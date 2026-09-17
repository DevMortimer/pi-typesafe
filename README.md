# pi-typesafe

[Jev](https://typesafe.ai) inside [Pi](https://pi.dev). Jev is TypeSafe's judgment model: you give it some state and typed questions, and it returns probabilities instead of prose, in well under a second, for a fraction of a cent. This package gives Pi three things built on it:

- **A tool for the agent.** `typesafe_evaluate` lets Pi's main model hand off small structured judgments (classify, triage, compare, score) and get calibrated numbers back, in one batched call.
- **A playground.** `/typesafe playground` and `/typesafe test` run requests from the terminal without touching the model's context.
- **A typed API for other extensions.** One client, one key store, one login prompt, so extensions such as [pi-warden](https://github.com/DevMortimer/pi-warden) do not each ask for a key.

![Pi triaging three bug reports with one batched TypeSafe call: the prompt, the rendered TypeSafe answers, and the agent's verdict](https://raw.githubusercontent.com/DevMortimer/pi-typesafe/main/docs/preview.png)

Independent project. Not affiliated with TypeSafe AI or the Pi authors.

## In one minute

```bash
pi install npm:pi-typesafe
```

Then, inside Pi:

1. `/typesafe login` and paste a key from [console.typesafe.ai](https://console.typesafe.ai). Input is hidden; the key is verified against the API and saved to `~/.pi/agent/pi-typesafe/auth.json` with owner-only permissions.
2. `/typesafe test` sends one built-in sample request and shows the answers.
3. `/typesafe enable` lets the agent call the tool for this session, after you confirm the data notice.

Requires Pi 0.85 or newer and Node.js 22.19 or newer. Usage is billed to your TypeSafe account. For CI or scripts set `TYPESAFE_API_KEY` in the environment instead; it takes precedence over the stored key. Do not paste the key into chat, command arguments, or project files.

## The three question types

Jev answers three kinds of question about the state you send. Every question in a request is evaluated in parallel and in isolation, so adding questions barely changes the latency.

| Type | Asks | Returns |
| --- | --- | --- |
| **Choice** | Which of these options fits? | the chosen key, a probability per option, confidence |
| **Score** | Where on this ordered rubric does it sit? | a position (may be fractional), probabilities, confidence |
| **Noul** | Is this statement true? | a probability from 0 to 1 |

Example request the agent could send about a support message:

```json
{
  "state": { "message": "I was charged twice. Please help today." },
  "questions": {
    "team": { "type": "choice", "instructions": "Which team should handle this?",
              "criteria": { "billing": "Charges and payments", "technical": "Software failures", "other": "None of these" } },
    "urgent": { "type": "noul", "instructions": "Does the sender request help today?" },
    "frustration": { "type": "score", "instructions": "How frustrated does the sender sound?",
                     "criteria": ["Neutral request", "Frustrated but civil", "Explicit anger or threats"] }
  }
}
```

Read probabilities and confidence alongside the answer. Confidence describes how concentrated the distribution is; it is not proof of correctness or permission to act.

## The agent tool

`typesafe_evaluate` is registered at startup but **disabled until you run `/typesafe enable`** in the session. For automated or headless runs, set `PI_TYPESAFE_ENABLED=1` explicitly.

The tool accepts JSON `state` plus 1 to 32 questions and returns answers, model, token usage, and elapsed time. Good uses: triaging a list of issues in one call, deciding which of several files a change belongs to, checking whether a reply answers the question that was asked, scoring candidates against a rubric you wrote. Bad uses: anything that needs reasoning across steps, or a single question that mixes several judgments.

## Writing questions that work

The question text is the whole program. Jev answers exactly what is asked, so ambiguity shows up as a middling probability rather than an error.

- **Ask about what the state says, not what you would conclude.** A report that says "happens every time" scored `P(yes) = 0.36` for `Is the bug reproducible from the text?` because that can also mean "could a reader reproduce it using only this text?". `Does the reporter state that the problem occurs consistently?` is the intended question.
- **Describe situations in Score levels, not degrees.** `"Workaround exists"` is checkable; `"medium"` is not.
- **Include a no-match option** in a Choice (`other`, `unclear`) when nothing may fit; the model cannot pick an option you omitted.
- **One judgment per question.** Split independent dimensions into separate questions and batch them in one request; they run in parallel and cannot see each other.
- **Name the state fields you mean** with backticks (`` `report.body` ``) when the state has several parts.

The [TypeSafe docs](https://docs.typesafe.ai/primitives) cover each primitive in detail.

## Commands

| Command | Effect |
| --- | --- |
| `/typesafe login` | Enter and verify an API key (hidden input), then store it |
| `/typesafe logout` | Delete the stored key and disable the tool |
| `/typesafe setup` | Check which key is in use; starts login if none |
| `/typesafe status` | Opt-in state, attempts used, token totals |
| `/typesafe enable` | Confirm the data notice and allow agent tool calls this session |
| `/typesafe disable` | Stop future agent tool calls |
| `/typesafe test` | Send one built-in sample request |
| `/typesafe playground` | Edit request JSON in Pi's editor, confirm, view results |

Playground and test results are shown in the terminal only; they do not enter the model's context.

## Questions people ask

**Do I need a key to install?**
Install works without one; nothing is sent until you log in and enable the tool. Jev is new and access may be limited at the moment. Keys come from [console.typesafe.ai](https://console.typesafe.ai).

**What does a request cost?**
Whatever TypeSafe bills for the input tokens of your state and questions; output is free. At the listed rate ($42 per billion input tokens at the time of writing) a typical request of a few hundred tokens costs well under a hundredth of a cent. The per-session cap is 20 attempts; `/typesafe status` shows the totals.

**Why not just ask the main model?**
The main model can answer any of these questions in prose. It is slower, costs more per call, and grades its own work. Jev returns a calibrated number your code or the agent can branch on, in a quarter of a second, from a separate model. That matters most when the same question is asked many times (every tool call, every file, every issue in a list).

**What is sent?**
Only the state and questions you (or the agent, once enabled) submit, to `https://api.typesafe.ai` only. No files, conversation history, or telemetry are collected. Error messages never include upstream response bodies, headers, keys, or your submitted state.

**Limits?**
Per request: 32 questions and 64 KiB of JSON. Per session: 20 attempts, 15-second timeout, no automatic retries. Limits reset when a session starts or reloads. The SDK's `TYPESAFE_BASE_URL` and `TYPESAFE_LOG_LEVEL` overrides are ignored.

## For extension authors

Import the library from your own extension. It has no dependency on Pi and is safe to use in tests.

```ts
import { createTypeSafe, choice, noul, score } from "pi-typesafe";

const typesafe = createTypeSafe({ maxRequests: 5 });       // key: TYPESAFE_API_KEY, else the /typesafe login store
const result = await typesafe.evaluate({
  state: { title: "Login fails after update", body: "..." },
  questions: {
    area: choice("Which area does this report concern?", { auth: "Sign-in", ui: "Layout", other: null }),
    duplicate: noul("Does the report describe the same defect as `known_issue`?"),
    severity: score("How severe is the defect?", ["Cosmetic", "Workaround exists", "Blocking"]),
  },
});
result.answers.area.choice;        // "auth" | "ui" | "other"
result.answers.duplicate.noul;     // 0..1
result.answers.severity.score;     // 0..2, may be fractional
result.usage, result.elapsedMs, typesafe.getUsage();
```

| Export | Purpose |
| --- | --- |
| `createTypeSafe(options)` | Client. Options: `apiKey`, `model` (default `jev-latest`), `timeoutMs`, `maxInputBytes`, `maxRequests`, `fetch` (inject a transport for offline tests). |
| `evaluate(request, { signal })` | Validates before sending; rejects with `TypeSafeIntegrationError` (`code`: `configuration`, `validation`, `budget`, `aborted`, `timeout`, `http`, `connection`, `response`). |
| `prepareEvaluationRequest(value, { maxInputBytes })` | The admission rule as a function: normalizes the near-miss aliases the agent tool accepts (`options`/`levels`/`choices`, a string Noul criterion, a label array), validates, then enforces the byte budget. `DEFAULT_MAX_INPUT_BYTES` and `DEFAULT_MAX_REQUESTS` hold the shared defaults. |
| `listModels()` | Verifies the key with a GET request that does not count toward `maxRequests`. |
| `resolveApiKey()`, `ensureApiKey()` | Report whether a key comes from the environment or the login store without your extension handling the value. Frozen for existing callers. |
| `keySituation()`, `keySourceLabel(situation)` | The same answer without throwing: `{ kind: "environment" \| "stored" \| "missing" \| "unusable", key?, path?, reason? }`, plus a label for the source. |
| `credentialsPath()`, `storeApiKey(value)`, `clearStoredApiKey()` | Where the key lives and how to manage the owner-only store. |
| `evaluationSchema`, `parseEvaluationRequest` | TypeBox schema and parser for tools that accept request JSON. |
| `pi-typesafe/ui`: `ensureApiKey(ctx)`, `loginWithPrompt`, `promptForApiKey` | The same hidden-input login as `/typesafe login` for your own command. `ensureApiKey(ctx)` returns the existing key source or prompts, verifies, and stores a new key (undefined when the user cancels). Needs Pi's TUI, so use it only inside extension command handlers. |

Your extension owns its own user consent and budget; `/typesafe enable` applies only to this package's tool. See [`examples/decision-extension.ts`](examples/decision-extension.ts), and [pi-warden](https://github.com/DevMortimer/pi-warden) for a full extension built this way.

## Development

```bash
npm install
npm run check        # typecheck, offline tests, build
cp .env.example .env # add your key locally; .env is git-ignored
npm run test:live    # one billable sample request
npm run dev:pi       # start Pi with only this working tree as extension (.env optional)
```

## License

MIT
