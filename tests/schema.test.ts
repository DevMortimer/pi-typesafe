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

test("every field the agent authors carries a description, so a bare union is not its only guidance", () => {
  // Walk the serialized schema rather than pin TypeBox's layout: collect every `properties` entry by name.
  const authored = new Map<string, number>();
  const undescribed: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const [name, field] of Object.entries(record.properties as Record<string, Record<string, unknown>>)) {
        authored.set(name, (authored.get(name) ?? 0) + 1);
        if (typeof field.description !== "string" || field.description.length === 0) undescribed.push(name);
      }
    }
    Object.values(record).forEach(walk);
  };
  walk(JSON.parse(JSON.stringify(evaluationSchema)));
  assert.equal(authored.get("type"), 3, "the schema must still offer noul, choice, and score");
  for (const name of ["state", "questions", "model", "instructions", "criteria"]) assert.ok(authored.has(name), `${name} is still authored`);
  // `true` and `false` inside noul criteria are the only fields whose parent already explains them.
  assert.deepEqual(undescribed.filter(name => name !== "true" && name !== "false"), [], "every authored field must say what it means");
});
