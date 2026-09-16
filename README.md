# pi-typesafe

TypeSafe decisions inside [Pi](https://pi.dev): one batched evaluation tool for the agent, a terminal playground, and a typed API that other Pi extensions can build on.

[TypeSafe](https://typesafe.ai) models (Jev) answer typed questions about supplied state: **Choice** (one of a set), **Score** (position on an ordered rubric), and **Noul** (probability of yes). They return calibrated probabilities in well under a second instead of generated text. Pi's main model keeps writing and reasoning; TypeSafe handles small, structured judgments.

Independent project. Not affiliated with TypeSafe AI or the Pi authors.

![Pi triaging three bug reports with one batched TypeSafe call: the prompt, the rendered TypeSafe answers, and the agent's verdict](https://raw.githubusercontent.com/DevMortimer/pi-typesafe/main/docs/preview.png)

## Install

```bash
pi install npm:pi-typesafe
```

Requires Pi 0.85 or newer and Node.js 22.19 or newer. Bring your own TypeSafe API key; usage is billed to your TypeSafe account.

## Setup

1. Get a key at [console.typesafe.ai](https://console.typesafe.ai) (API Keys).
2. In Pi, run `/typesafe login` and paste the key. Input is hidden; the key is verified against the API, then saved to `~/.pi/agent/pi-typesafe/auth.json` with owner-only permissions.
3. Run `/typesafe test` for one sample request, or `/typesafe enable` to let the agent call the tool.

Other extensions built on this package pick up the same stored key automatically. For CI or scripts, set `TYPESAFE_API_KEY` in the environment instead; it takes precedence over the stored key. Do not paste the key into chat, command arguments, or project files.

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

## The agent tool

`typesafe_evaluate` is registered at startup but **disabled until you run `/typesafe enable`** in the session. For automated or headless runs, set `PI_TYPESAFE_ENABLED=1` explicitly.

The tool accepts JSON `state` plus 1–32 questions and returns answers, model, token usage, and elapsed time. Example request:

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

## Writing questions that work

The question text is the whole program. Jev answers exactly what is asked, so ambiguity shows up as a middling probability rather than an error.

- **Ask about what the state says, not what you would conclude.** A report that says "happens every time" scored `P(yes) = 0.36` for `Is the bug reproducible from the text?` because that can also mean "could a reader reproduce it using only this text?". `Does the reporter state that the problem occurs consistently?` is the intended question.
- **Describe situations in Score levels, not degrees.** `"Workaround exists"` is checkable; `"medium"` is not.
- **Include a no-match option** in a Choice (`other`, `unclear`) when nothing may fit; the model cannot pick an option you omitted.
- **One judgment per question.** Split independent dimensions into separate questions and batch them in one request; they run in parallel and cannot see each other.
- **Name the state fields you mean** with backticks (`` `report.body` ``) when the state has several parts.

The [TypeSafe docs](https://docs.typesafe.ai/primitives) cover each primitive in detail.

## Data handling and limits

- Only the state and questions you (or the agent, once enabled) submit are sent, to `https://api.typesafe.ai` only. No files, conversation history, or telemetry are collected.
- Every request costs TypeSafe tokens. Limits per session: 32 questions and 64 KiB JSON per request, 20 attempts, 15-second timeout, no automatic retries. Limits reset when a session starts or reloads.
- Error messages never include upstream response bodies, headers, keys, or your submitted state.
- The SDK's `TYPESAFE_BASE_URL` and `TYPESAFE_LOG_LEVEL` overrides are ignored.

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

- `createTypeSafe(options)`: `apiKey`, `model` (default `jev-latest`), `timeoutMs`, `maxInputBytes`, `maxRequests`, `fetch` (inject a transport for offline tests).
- `evaluate(request, { signal })` validates before sending and rejects with `TypeSafeIntegrationError` (`code`: `configuration`, `validation`, `budget`, `aborted`, `timeout`, `http`, `connection`, `response`).
- `listModels()` verifies the key with a GET request that does not count toward `maxRequests`.
- `resolveApiKey()` reports whether a key comes from the environment or the login store, without your extension handling the value; `credentialsPath()` tells users where it lives. `storeApiKey(value)` and `clearStoredApiKey()` manage that store with owner-only permissions.
- `import { ensureApiKey, loginWithPrompt, promptForApiKey } from "pi-typesafe/ui"` gives your own command the same hidden-input login as `/typesafe login`: `ensureApiKey(ctx)` returns the existing key source or prompts, verifies, and stores a new key (undefined when the user cancels). This subpath needs Pi's TUI, so use it only inside extension command handlers.
- `evaluationSchema` (TypeBox) and `parseEvaluationRequest` are exported for tools that accept request JSON.
- Your extension owns its own user consent and budget; `/typesafe enable` applies only to this package's tool.

See [`examples/decision-extension.ts`](examples/decision-extension.ts).

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
