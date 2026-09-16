import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTypeSafe, choice, noul, TypeSafeIntegrationError } from "pi-typesafe";

// A separate extension using the public API, not pi-typesafe's private modules.
// It owns its own consent and request budget; it does not reuse /typesafe enable.
export default function decisionExample(pi: ExtensionAPI): void {
  pi.registerCommand("decision-demo", {
    description: "Send one synthetic, batched decision request to TypeSafe",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      if (!await ctx.ui.confirm("Send a TypeSafe request?", "This synthetic example goes to api.typesafe.ai and may incur charges.")) return;
      try {
        const client = createTypeSafe({ maxRequests: 1 });
        const result = await client.evaluate({
          state: "Please refund the duplicate charge.",
          questions: {
            team: choice("Which team should handle the request?", {
              billing: "Payments and refunds", engineering: "Software defects", other: "Anything else",
            }),
            refund: noul("Is the sender requesting a refund?"),
          },
        });
        ctx.ui.notify(`Team: ${result.answers.team.choice}; P(refund): ${result.answers.refund.noul}; ${result.elapsedMs} ms`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof TypeSafeIntegrationError ? error.message : "The example could not complete.", "error");
      }
    },
  });
}
