# Contributing to pi-typesafe

pi-typesafe is the TypeSafe client other Pi extensions build on: key storage, consent, budgets, validated responses, and the `typesafe_evaluate` tool. A small, predictable surface is the feature. Please keep it that way.

## Report

- **A bug.** Use the "Bug" template with the Pi and pi-typesafe versions, the error text Pi showed, and the smallest sequence that reproduces it. `/typesafe status` output helps.
- **A gap for extension authors.** Use the "Extension author request" template: what you are building, what the client does not let you do, and the smallest API that would.
- **Security.** A way to expose a key, an upstream response body, or submitted content: use the private security advisory, not a public issue.

## Change

1. `npm install`, then `npm run check` (typecheck, offline tests with an injected `fetch`, build). It must pass before and after your change.
2. Behaviour changes come with tests in `tests/`. Everything is testable offline through the `fetch` option; no test may need a key or the network.
3. `npm run test:live` sends one billable request with your own key. Run it when you touch the transport or the response validation and say so in the PR.

## Rules the code keeps

- **The public API is `src/index.ts`.** Adding an export needs a line in the README's "For extension authors" section; removing or changing one needs a minor version bump until 1.0 and a note in the release.
- **No new runtime dependencies without a reason in the PR.** Today: `@typesafe-ai/sdk` and `typebox`.
- **Nothing from upstream reaches the user unvalidated.** Responses are checked against the questions before a caller sees them; an invalid response is an error, never a partial answer.
- **Errors carry a code and a safe message.** Never a response body, never the key, never the submitted state.
- **Keys are owner-only and never returned.** `resolveApiKey` tells you where a key came from, not what it is.
- **Consent and budget are enforced here, not in callers.** `maxRequests` counts attempts, including failures; a caller cannot exceed it by retrying.

## Commits and pull requests

- One change per commit, a message that says what and why, no tool or AI attribution lines.
- One topic per PR; update the README in the same PR when behaviour changes.
- Releases are cut by the maintainer; do not bump `package.json` in a PR.

## Where to ask

Issues here, or the Pi and TypeSafe Discord servers. Critique the code, not the person.
