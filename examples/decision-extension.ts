import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ask, authState, createTypeSafe, choice, describeAuth, noul } from "pi-typesafe";

// A separate extension using the public API, not pi-typesafe's private modules.
// It owns its own consent and request budget; it does not reuse /typesafe enable.
export default function decisionExample(pi: ExtensionAPI): void {
  pi.registerCommand("decision-demo", {
    description: "Send one synthetic, batched decision request to TypeSafe",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      // Say which key is in effect before showing a data notice, so a missing one is not mistaken for consent.
      const auth = describeAuth(authState());
      if (auth.level === "error") {
        ctx.ui.notify(auth.text, "warning");
        return;
      }
      if (!await ctx.ui.confirm("Send a TypeSafe request?", "This synthetic example goes to api.typesafe.ai and may incur charges.")) return;
      try {
        // One client instance, one session budget, and a daily spend cap the script cannot forget.
        const client = createTypeSafe({ maxRequests: 1, maxUsdPerDay: 1 });
        const answer = await ask(client, {
          state: "Please refund the duplicate charge.",
          questions: {
            team: choice("Which team should handle the request?", {
              billing: "Payments and refunds", engineering: "Software defects", other: "Anything else",
            }),
            refund: noul("Is the sender requesting a refund?"),
          },
        }, { timeoutMs: 5_000 });
        if (!answer.ok) {
          ctx.ui.notify(answer.errorCode === "budget" ? `No request was sent: ${answer.error}` : "The example could not complete.", "warning");
          return;
        }
        ctx.ui.notify(`Team: ${answer.answers.team.choice}; P(refund): ${answer.answers.refund.noul}; ${answer.elapsedMs} ms`, "info");
      } catch (error) {
        // createTypeSafe rejects an unusable key store; ask() never throws.
        ctx.ui.notify(error instanceof Error ? error.message : "The example could not start.", "error");
      }
    },
  });
}
