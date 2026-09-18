import type { SystemOneRequest } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { TypeSafeIntegrationError } from "./errors.js";

/** Default UTF-8 JSON byte budget for one evaluation request; the tool and the client share it. */
export const DEFAULT_MAX_INPUT_BYTES = 65_536;

/** Questions one request may ask. More than this needs `chunkEvaluationRequest`, which splits and fans out. */
export const DEFAULT_MAX_QUESTIONS = 32;

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
    maxProperties: DEFAULT_MAX_QUESTIONS,
  }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

const usage = `Expected { state, questions: { <id>: { type: "choice", instructions, criteria: { label: description|null } } | { type: "score", instructions, criteria: [level0, level1, ...] } | { type: "noul", instructions } } }; 1–${DEFAULT_MAX_QUESTIONS} questions, Choice 1–64 options, Score 2–32 levels.`;

/** Paths and messages only; never the submitted values. */
function describeSchemaErrors(value: unknown): string {
  const details: string[] = [];
  for (const error of Errors(evaluationSchema, value)) {
    const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".") || "request";
    details.push(`${path.slice(0, 120)}: ${error.message}`);
    if (details.length === 3) break;
  }
  return details.join("; ");
}

/** Validate without including submitted content in validation errors. Prefer prepareEvaluationRequest(), which also accepts near-misses and enforces the byte budget. */
export function parseEvaluationRequest(value: unknown): SystemOneRequest {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !isJsonSafe(value)) {
    throw new TypeSafeIntegrationError("validation", `Invalid evaluation request: state and questions must be plain JSON. ${usage}`);
  }
  if (!Check(evaluationSchema, value)) {
    throw new TypeSafeIntegrationError("validation", `Invalid evaluation request at ${describeSchemaErrors(value)}. ${usage}`);
  }
  return value as SystemOneRequest;
}

function isJsonSafe(value: unknown): boolean {
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
    return true;
  } catch {
    return false;
  }
}

/** Accept common near-misses from language models without loosening the schema itself. Prefer prepareEvaluationRequest(), which applies this before validating. */
export function normalizeEvaluationRequest(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const request = value as Record<string, unknown>;
  const questions = request.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions as Record<string, unknown>)) {
    if (!question || typeof question !== "object" || Array.isArray(question)) { normalized[id] = question; continue; }
    const { options, levels, choices, ...rest } = question as Record<string, unknown>;
    const item: Record<string, unknown> = { ...rest };
    if (item.criteria === undefined) {
      const alias = options ?? levels ?? choices;
      if (alias !== undefined) item.criteria = alias;
    }
    if (item.type === "choice" && Array.isArray(item.criteria) && item.criteria.every(label => typeof label === "string" && label)) {
      item.criteria = Object.fromEntries((item.criteria as string[]).map(label => [label, null]));
    }
    if (item.type === "noul" && typeof item.criteria === "string") {
      item.criteria = { true: item.criteria };
    }
    normalized[id] = item;
  }
  return { ...request, questions: normalized };
}

export interface PrepareEvaluationOptions {
  /** UTF-8 JSON bytes of the serialized request. Default: DEFAULT_MAX_INPUT_BYTES. */
  maxInputBytes?: number;
}

/** One byte rule for every limit check: measure the serialized request and name the configured limit. */
export function assertWithinByteLimit(text: string, maxInputBytes: number): void {
  if (Buffer.byteLength(text, "utf8") > maxInputBytes) {
    throw new TypeSafeIntegrationError("validation", `Evaluation exceeds the ${maxInputBytes}-byte input limit.`);
  }
}

/**
 * The one admission rule: normalize known near-miss aliases, validate the schema and JSON-safety, then enforce the byte
 * budget — always in that order. The Pi tool, the playground, and client.evaluate() all pass through here, so what one
 * accepts the others accept.
 */
export function prepareEvaluationRequest(value: unknown, options: PrepareEvaluationOptions = {}): SystemOneRequest {
  const validated = parseEvaluationRequest(normalizeEvaluationRequest(value));
  assertWithinByteLimit(JSON.stringify(validated), options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES);
  return validated;
}
