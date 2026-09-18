import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auc, calibrate, defaultThresholds, formatCalibration, metricsAt, pickThreshold, replay, samplesOf, sweep,
} from "../src/calibrate.js";
import { TypeSafeIntegrationError } from "../src/errors.js";

const sample = (score: number, label: boolean, id?: string) => ({ score, label, ...(id === undefined ? {} : { id }) });

/** Eight observations: two clear positives, two clear negatives, and a muddy middle. */
const muddy = [
  sample(0.95, true, "p1"), sample(0.8, true, "p2"), sample(0.6, true, "p3"), sample(0.4, true, "p4"),
  sample(0.7, false, "n1"), sample(0.5, false, "n2"), sample(0.2, false, "n3"), sample(0.05, false, "n4"),
];

test("AUC is the rank-based probability that a positive outranks a negative", () => {
  assert.equal(auc([sample(1, true), sample(0, false)]), 1);
  assert.equal(auc([sample(0, true), sample(1, false)]), 0);
  assert.equal(auc([sample(0.5, true), sample(0.5, false)]), 0.5);
  assert.equal(auc([sample(0.5, true), sample(0.5, true), sample(0.5, false), sample(0.5, false)]), 0.5);
  // One class only: nothing to rank against.
  assert.equal(auc([sample(0.5, true), sample(0.9, true)]), undefined);
  assert.equal(auc([]), undefined);
  // Three positives above one negative and one below: 3 wins of 4 pairs.
  assert.equal(auc([sample(0.9, true), sample(0.8, true), sample(0.7, true), sample(0.6, false), sample(0.1, true)]) ?? 0, 0.75);
});

test("a threshold row counts every case once", () => {
  const row = metricsAt(muddy, 0.6);
  assert.deepEqual({ ...row, precision: row.precision, recall: row.recall }, { threshold: 0.6, flagged: 4, tp: 3, fp: 1, fn: 1, tn: 3, precision: 0.75, recall: 0.75, flagRate: 0.5 });
  // At the top of the range nothing is flagged, so precision has no denominator.
  const strict = metricsAt(muddy, 1);
  assert.equal(strict.flagged, 0);
  assert.equal(strict.precision, undefined);
  assert.equal(strict.recall, 0);
  assert.deepEqual(sweep(muddy, [0.6]).map(entry => entry.tp), [3]);
});

test("the default threshold grid is every distinct score, ascending", () => {
  assert.deepEqual(defaultThresholds(muddy), [0.05, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.95]);
  assert.equal(defaultThresholds(muddy, 3).length, 3);
  assert.deepEqual(defaultThresholds([sample(0.5, true), sample(0.5, false)]), [0.5]);
});

test("a recommendation honours the floors, and the report names what it misses and flags", () => {
  const calibration = calibrate("muddy", muddy, { thresholds: [0.5, 0.6, 0.7, 0.8], minPrecision: 0.75, minRecall: 0.5 });
  assert.equal(calibration.recommended?.threshold, 0.6);
  assert.equal(calibration.scored, 8);
  assert.equal(calibration.positives, 4);
  assert.equal(calibration.negatives, 4);
  assert.equal(calibration.errors, 0);
  assert.ok((calibration.auc ?? 0) > 0.7);
  assert.deepEqual(calibration.missed.map(entry => entry.id), ["p4"]);
  assert.deepEqual(calibration.flagged.map(entry => entry.id), ["n1"]);
  const text = formatCalibration(calibration);
  assert.ok(text.includes("muddy: 8 scored, 4 positives, 4 negatives"));
  assert.ok(text.includes("recommended 0.60: precision 75%, recall 75%"));
  assert.ok(text.includes("missed positives (1): p4"));
  assert.ok(text.includes("flagged negatives (1): n1"));

  // Floors nothing can meet leave no recommendation, and the report says so.
  const impossible = calibrate("strict", muddy, { thresholds: [0.5], minPrecision: 0.99, minRecall: 0.99 });
  assert.equal(impossible.recommended, undefined);
  assert.ok(formatCalibration(impossible).includes("recommended: none"));
});

test("with no floors, the recommendation is the best F1 among the rows", () => {
  const rows = sweep(muddy, [0.4, 0.5, 0.6, 0.7]);
  // At 0.4 every positive is caught for two false alarms: F1 0.8 beats the tighter rows.
  assert.deepEqual(rows.map(row => row.tp), [4, 3, 3, 2]);
  assert.equal(pickThreshold(rows)?.threshold, 0.4);
  assert.equal(pickThreshold([]), undefined);
  // No positives: precision has no denominator, so no row can be ranked.
  assert.equal(pickThreshold(sweep([sample(0.5, false)], [0.5])), undefined);
});

test("replay scores labelled cases with bounded concurrency and keeps per-case order", async () => {
  let inFlight = 0;
  let peak = 0;
  const cases = [
    { id: "a", label: true, data: 1 },
    { id: "b", label: false, data: 2 },
    { id: "c", label: true, data: 3 },
    { id: "d", label: false, data: 4 },
  ];
  const results = await replay(cases, async data => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    return data;
  }, { concurrency: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => result.id), ["a", "b", "c", "d"]);
  assert.deepEqual(results.map(result => result.score), [1, 2, 3, 4]);
  assert.equal(results.every(result => !result.skipped && result.error === undefined), true);
  const { samples, errors } = samplesOf(results);
  assert.equal(errors, 0);
  assert.equal(samples.length, 4);
});

test("a budget failure stops the replay and leaves the rest unsubmitted", async () => {
  const started: string[] = [];
  const cases = [
    { id: "a", label: true, data: 1 },
    { id: "b", label: false, data: 2 },
    { id: "c", label: true, data: 3 },
    { id: "d", label: false, data: 4 },
  ];
  const results = await replay(cases, async data => {
    started.push(String(data));
    if (data === 2) throw new TypeSafeIntegrationError("budget", "TypeSafe request limit reached (1 attempts per client instance).");
    return 0.1;
  }, { concurrency: 1, stopOn: error => error instanceof TypeSafeIntegrationError && error.code === "budget" });
  assert.deepEqual(started, ["1", "2"]);
  assert.equal(results[1]?.error, "TypeSafe request limit reached (1 attempts per client instance).");
  assert.equal(results[1]?.skipped, false);
  // The budget stop kept every later case from being submitted at all.
  assert.equal(results[2]?.skipped, true);
  assert.equal(results[3]?.skipped, true);
  assert.equal(results[3]?.score, undefined);
  const { samples, errors } = samplesOf(results);
  assert.equal(errors, 3);
  assert.deepEqual(samples, [{ label: true, score: 0.1, id: "a" }]);
  // A replay that lost most of its cases still yields honest numbers.
  const calibration = calibrate("replay", samples, { errors });
  assert.equal(calibration.errors, 3);
  assert.equal(calibration.scored, 1);
  assert.equal(calibration.auc, undefined);
});

test("replay reports scorer failures with the caller's own message", async () => {
  const thrown = new Error("upstream body with a key: sk-secret");
  // The default is the scorer's own message, which the caller controls; a supplied describer replaces it.
  const plain = await replay([{ id: "boom", label: true, data: "case" }], async () => { throw thrown; });
  assert.equal(plain[0]?.error, "upstream body with a key: sk-secret");
  assert.equal(plain[0]?.score, undefined);
  const described = await replay([{ id: "boom", label: true, data: "case" }], async () => { throw thrown; }, {
    describeError: () => "The scorer failed.",
  });
  assert.equal(described[0]?.error, "The scorer failed.");
  const nonError = await replay([{ id: "boom", label: false, data: "case" }], async () => { throw "not an error"; });
  assert.equal(nonError[0]?.error, "The scorer failed.");
});
