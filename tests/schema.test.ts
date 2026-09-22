import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_INPUT_BYTES, evaluationSchema, normalizeEvaluationRequest, parseEvaluationRequest, prepareEvaluationRequest, TypeSafeIntegrationError,
} from "../src/index.js";

const hasCode = (code: string) => (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === code;

const nearMiss = () => ({
  state: "synthetic",
  questions: {
    team: { type: "choice", instructions: "Which team?", options: { billing: "Charges and payments", other: "None of these" } },
    refund: { type: "noul", instructions: "Is a refund requested?", criteria: "The sender asks for money back" },
    severity: { type: "score", instructions: "How severe?", levels: ["Cosmetic", "Blocking"] },
    picks: { type: "choice", instructions: "Pick one", choices: ["a", "b"] },
  },
});

const criteriaOf = (request: { questions: unknown }, id: string): unknown =>
  (request.questions as Record<string, { criteria?: unknown }>)[id]?.criteria;

test("admission accepts the near-miss aliases the agent tool has always accepted", () => {
  const prepared = prepareEvaluationRequest(nearMiss());
  assert.deepEqual(criteriaOf(prepared, "team"), { billing: "Charges and payments", other: "None of these" });
  assert.deepEqual(criteriaOf(prepared, "refund"), { true: "The sender asks for money back" });
  assert.deepEqual(criteriaOf(prepared, "severity"), ["Cosmetic", "Blocking"]);
  assert.deepEqual(criteriaOf(prepared, "picks"), { a: null, b: null });
});

test("admission normalizes before it validates", () => {
  const onlyValidAfterNormalizing = { state: "s", questions: { q: { type: "choice", criteria: ["a", "b"] } } };
  assert.throws(() => parseEvaluationRequest(onlyValidAfterNormalizing), hasCode("validation"));
  assert.doesNotThrow(() => prepareEvaluationRequest(onlyValidAfterNormalizing));
});

test("normalization is idempotent", () => {
  const once = normalizeEvaluationRequest(nearMiss());
  assert.deepEqual(normalizeEvaluationRequest(once), once);
  assert.doesNotThrow(() => prepareEvaluationRequest(once));
});

test("admission enforces the byte budget on the serialized request", () => {
  const request = { state: "🙂".repeat(50), questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } };
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  assert.ok(bytes < DEFAULT_MAX_INPUT_BYTES);
  assert.throws(() => prepareEvaluationRequest(request, { maxInputBytes: bytes - 1 }), hasCode("validation"));
  assert.doesNotThrow(() => prepareEvaluationRequest(request, { maxInputBytes: bytes }));
});

test("the default byte budget is 64 KiB", () => {
  const oversized = { state: "x".repeat(DEFAULT_MAX_INPUT_BYTES), questions: { yes: { type: "noul", instructions: "?" } } };
  assert.equal(DEFAULT_MAX_INPUT_BYTES, 65_536);
  assert.throws(() => prepareEvaluationRequest(oversized), hasCode("validation"));
  assert.doesNotThrow(() => prepareEvaluationRequest(oversized, { maxInputBytes: DEFAULT_MAX_INPUT_BYTES * 2 }));
});

test("admission still rejects non-JSON state", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => prepareEvaluationRequest({ state: cycle, questions: { yes: { type: "noul", instructions: "?" } } }), hasCode("validation"));
  assert.throws(() => prepareEvaluationRequest({ state: { n: NaN }, questions: { yes: { type: "noul", instructions: "?" } } }), hasCode("validation"));
});

type Field = { description?: string };
type Variant = { properties: { type: Field; instructions: Field; criteria: Field } };

test("every field the agent authors carries a description, so a bare union is not its only guidance", () => {
  const schema = evaluationSchema as unknown as {
    properties: {
      state: Field;
      model: Field;
      questions: Field & { patternProperties: { "^.*$": { anyOf: Variant[] } } };
    };
  };
  const { state, model, questions } = schema.properties;
  const variants = questions.patternProperties["^.*$"].anyOf;
  assert.equal(variants.length, 3, "the schema must still offer noul, choice, and score");
  const authored: Field[] = [
    state, model, questions,
    ...variants.flatMap(variant => [variant.properties.type, variant.properties.instructions, variant.properties.criteria]),
  ];
  for (const field of authored) assert.ok(field.description, "every authored field must say what it means");
});
