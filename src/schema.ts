import type { SystemOneRequest } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { TypeSafeIntegrationError } from "./errors.js";

// The API accepts structured descriptions, not only strings.
const entry = Type.Union([
  Type.String(),
  Type.Null(),
  Type.Array(Type.Unknown()),
  Type.Record(Type.String(), Type.Unknown()),
]);
const instructions = Type.Optional(entry);
const question = Type.Union([
  Type.Object({
    type: Type.Literal("noul"),
    instructions,
    criteria: Type.Optional(Type.Union([
      Type.Null(),
      Type.Object({ true: Type.Optional(entry), false: Type.Optional(entry) }, { additionalProperties: false }),
    ])),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("choice"),
    instructions,
    criteria: Type.Record(Type.String({ minLength: 1, maxLength: 200 }), entry, { minProperties: 1, maxProperties: 64 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("score"),
    instructions,
    criteria: Type.Array(entry, { minItems: 2, maxItems: 32 }),
  }, { additionalProperties: false }),
]);

/** The JSON schema used by both the Pi tool and the programmatic interface. */
export const evaluationSchema = Type.Object({
  state: entry,
  questions: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), question, {
    minProperties: 1,
    maxProperties: 32,
  }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

/** Validate without including submitted content in validation errors. */
export function parseEvaluationRequest(value: unknown): SystemOneRequest {
  try {
    // Walk before schema validation to reject cycles and non-JSON values.
    // Object descriptors avoid executing getters while checking user data.
    const ancestors = new Set<object>();
    const walk = (item: unknown, depth: number): void => {
      if (depth > 64) throw new Error();
      if (item === null || typeof item === "string" || typeof item === "boolean") return;
      if (typeof item === "number" && Number.isFinite(item)) return;
      if (typeof item !== "object" || ancestors.has(item)) throw new Error();
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error();
      ancestors.add(item);
      if (Object.getOwnPropertySymbols(item).length) throw new Error();
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (Array.isArray(item) && key === "length") continue;
        if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new Error();
        // SDK helpers include optional object fields whose value is undefined.
        // JSON serialization omits those fields; array elements must remain JSON.
        if (descriptor.value === undefined && !Array.isArray(item)) continue;
        walk(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    };
    walk(value, 0);
    if (!Check(evaluationSchema, value)) throw new Error();
    return value as SystemOneRequest;
  } catch {
    throw new TypeSafeIntegrationError("validation", "Invalid evaluation request: use JSON state and 1–32 typed questions; Choice needs 1–64 options and Score needs 2–32 levels.");
  }
}
