# pi-typesafe

[![CI](https://github.com/DevMortimer/pi-typesafe/actions/workflows/ci.yml/badge.svg)](https://github.com/DevMortimer/pi-typesafe/actions/workflows/ci.yml)

[Jev](https://typesafe.ai) inside [Pi](https://pi.dev). Jev is TypeSafe's judgment model: send it some state and typed questions and it returns probabilities instead of prose, in well under a second, for a fraction of a cent. This package gives Pi three things built on it:

- **A tool for the agent.** `typesafe_evaluate` hands small structured judgments (classify, triage, compare, score) to Jev and returns calibrated numbers in one batched call.
- **A playground.** `/typesafe test` and `/typesafe playground` run requests from the terminal without touching the model's context.
- **A typed API for other extensions.** One client, one key store, one login prompt, so extensions such as [pi-warden](https://github.com/DevMortimer/pi-warden) do not each ask for a key — and so a long run can tell you whether Jev was reachable and what it cost.

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

Jev answers three kinds of question about the state you send. Every question in a request runs in parallel and in isolation, so adding questions barely changes the latency.

| Type | Asks | Returns |
| --- | --- | --- |
| **Choice** | Which of these options fits? | the chosen key, a probability per option, confidence |
| **Score** | Where on this ordered rubric does it sit? | a position (may be fractional), probabilities, confidence |
| **Noul** | Is this statement true? | a probability from 0 to 1 |

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

## Availability and spend

An enabled extension with no usable key looks exactly like a working one — one evaluation ran keyless for hours before anyone noticed. Three answers exist now, and `/typesafe status` prints all of them:

- **Is Jev reachable?** `authState()` reports the key source, whether it has been accepted, and the last failure that degraded it; `describeAuth()` turns that into a level and one safe line. The extension calls both at session start and after an authentication rejection, so a headless run says judgments are skipped instead of quietly falling back to its offline path.
- **What has this run cost?** `getSpend()` returns session counters, today's persisted counters, and the cap currently reached. Cost is estimated from input tokens only, because output is free.
- **When does it stop?** `maxRequests` bounds a client instance. Three caps bound a local day, survive restarts, and stop a request before it is submitted:

| Option | Environment | Bounds |
| --- | --- | --- |
| `maxRequestsPerDay` | `PI_TYPESAFE_MAX_REQUESTS_PER_DAY` | requests |
| `maxInputTokensPerDay` | `PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY` | input tokens |
| `maxUsdPerDay` | `PI_TYPESAFE_MAX_USD_PER_DAY` | estimated spend |

The environment may lower an explicit cap but never raise it. A reached cap raises a `budget` error naming the cap, the amount used, and the day.

Need more than one request? `evaluateAll(request)` asks any number of questions about one state (over 32 are chunked and fanned out), and `evaluateMany(requests)` runs several requests at once. Both preserve order, bound concurrency, never throw, and stop submitting once the budget is gone. [`pi-typesafe/calibrate`](docs/api.md#calibration-pi-typesafecalibrate) turns labelled cases into thresholds with AUC, a sweep, and a replay runner.

## Commands

| Command | Effect |
| --- | --- |
| `/typesafe login` | Enter and verify an API key (hidden input), then store it |
| `/typesafe logout` | Delete the stored key and disable the tool |
| `/typesafe setup` | Check which key is in use; starts login if none |
| `/typesafe status` | Opt-in state, key state, session and today's counters, cost estimate, any reached cap |
| `/typesafe enable` | Confirm the data notice and allow agent tool calls this session |
| `/typesafe disable` | Stop future agent tool calls |
| `/typesafe test` | Send one built-in sample request |
| `/typesafe playground` | Edit request JSON in Pi's editor, confirm, view results |

Playground and test results are shown in the terminal only; they do not enter the model's context.

## Questions people ask

**Do I need a key to install?**
Install works without one; nothing is sent until you log in and enable the tool. Jev is new and access may be limited at the moment. Keys come from [console.typesafe.ai](https://console.typesafe.ai).

**What does a request cost?**
Whatever TypeSafe bills for the input tokens of your state and questions; output is free. At the listed rate ($42 per billion input tokens at the time of writing) a few hundred tokens cost well under a hundredth of a cent. The per-session cap is 20 attempts, and `maxUsdPerDay` stops a long run at a number you choose.

**Why not just ask the main model?**
The main model can answer any of these questions in prose. It is slower, costs more per call, and grades its own work. Jev returns a calibrated number your code or the agent can branch on, in a quarter of a second, from a separate model. That matters most when the same question is asked many times: every tool call, every file, every issue in a list.

**What is sent?**
Only the state and questions you (or the agent, once enabled) submit, to `https://api.typesafe.ai` only. No files, conversation history, or telemetry. Error messages never include upstream response bodies, headers, keys, or your submitted state.

**Limits?**
Per request: 32 questions and 64 KiB of JSON. Per session: 20 attempts, 15-second timeout, no automatic retries. Per day: no cap unless you set one. Session limits reset when a session starts or reloads; daily counters live in `~/.pi/agent/pi-typesafe/usage.json` and roll over at local midnight. The SDK's `TYPESAFE_BASE_URL` and `TYPESAFE_LOG_LEVEL` overrides are ignored.

## For extension authors

Import the library from your own extension. It has no dependency on Pi and is safe in tests.

```ts
import { ask, createTypeSafe, choice, noul, score } from "pi-typesafe";

const typesafe = createTypeSafe({ maxRequests: 5, maxUsdPerDay: 1 });  // key: TYPESAFE_API_KEY, else the login store
const answer = await ask(typesafe, {
  state: { title: "Login fails after update", body: "..." },
  questions: {
    area: choice("Which area does this report concern?", { auth: "Sign-in", ui: "Layout", other: null }),
    duplicate: noul("Does the report describe the same defect as `known_issue`?"),
    severity: score("How severe is the defect?", ["Cosmetic", "Workaround exists", "Blocking"]),
  },
}, { timeoutMs: 5_000 });
if (!answer.ok) return { skipped: answer.errorCode === "budget" };  // never throws
```

Your extension owns its own user consent and budget; `/typesafe enable` applies only to this package's tool. Check `authState()` rather than your own consent flag before you report that judgments are on.

Judgments can also go through OpenRouter: `createTypeSafe({ backend: "openrouter" })` sends them to `openrouter.ai` with the key from `OPENROUTER_API_KEY`. That backend has no login store, so `/typesafe login` does not apply to it. Pass the same `backend` to `authState`, `keySituation`, and `ensureApiKey`, or the status you report describes the TypeSafe key while the requests use another one. The `/typesafe` commands and the `typesafe_evaluate` tool always use the TypeSafe backend. Every export — the client, `ask`, batching, the usage ledger, auth state, and the `pi-typesafe/calibrate` and `pi-typesafe/ui` entry points — is in [docs/api.md](docs/api.md).

## Development

```bash
npm ci
npm run check        # build, typecheck, offline tests
cp .env.example .env # add your key locally; .env is git-ignored
npm run test:live    # one billable sample request
npm run dev:pi       # start Pi with only this working tree as extension (.env optional)
```

Pull requests run key-free checks on Linux and macOS, supported Node versions, and the installed npm package. Version tags prepare a draft release; npm publishing stays manual. See [Contributing](CONTRIBUTING.md) and [CI and continuous delivery](docs/ci-cd.md).

## License

MIT
