import { fanOut } from "./batch.js";
import type { Settled } from "./batch.js";

/**
 * A judge-tuning kit: label a set of cases, score them with Jev, and read off AUC and threshold behaviour. It carries
 * no domain knowledge — a case is anything a scorer can turn into a number — so the same toolkit fits an action guard,
 * a triage rule, or a prose check. `scripts/calibrate-action.mjs` in pi-warden is the worked example it came from.
 */

/** One labelled observation: the truth about the case, and the number the judge assigned to it. */
export interface ScoredSample {
  readonly label: boolean;
  readonly score: number;
  /** Optional name; used in the missed and flagged listings. */
  readonly id?: string;
}

/** Outcome counts for one threshold. `precision` and `recall` are undefined when their denominator is empty. */
export interface ThresholdRow {
  readonly threshold: number;
  readonly flagged: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision?: number;
  readonly recall?: number;
  /** Share of all cases the threshold selects. */
  readonly flagRate: number;
}

export interface Calibration {
  readonly name: string;
  readonly scored: number;
  readonly positives: number;
  readonly negatives: number;
  readonly errors: number;
  /** Rank-based AUC (Mann–Whitney, ties count half); undefined when one class is empty. */
  readonly auc?: number;
  readonly rows: readonly ThresholdRow[];
  /** The lowest threshold meeting the requested precision and recall floors, when one exists. */
  readonly recommended?: ThresholdRow;
  /** Positive cases the recommended threshold misses. */
  readonly missed: readonly ScoredSample[];
  /** Negative cases the recommended threshold flags. */
  readonly flagged: readonly ScoredSample[];
}

export interface CalibrateOptions {
  /** Thresholds to evaluate. Default: every distinct score, ascending (at most 64 rows). */
  thresholds?: readonly number[];
  /** Precision floor for the recommendation. */
  minPrecision?: number;
  /** Recall floor for the recommendation. */
  minRecall?: number;
  /** Cases that could not be scored; reported and excluded from the metrics. */
  errors?: number;
}

export function auc(samples: readonly ScoredSample[]): number | undefined {
  const positives = samples.filter(sample => sample.label).map(sample => sample.score);
  const negatives = samples.filter(sample => !sample.label).map(sample => sample.score);
  if (!positives.length || !negatives.length) return undefined;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) wins += positive > negative ? 1 : positive === negative ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator ? numerator / denominator : undefined;
}

/** Counts at one threshold: a case is flagged when its score is at least the threshold. */
export function metricsAt(samples: readonly ScoredSample[], threshold: number): ThresholdRow {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const sample of samples) {
    const flagged = sample.score >= threshold;
    if (flagged && sample.label) tp++;
    else if (flagged) fp++;
    else if (sample.label) fn++;
    else tn++;
  }
  const flagged = tp + fp;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    threshold,
    flagged,
    tp,
    fp,
    fn,
    tn,
    ...(precision === undefined ? {} : { precision }),
    ...(recall === undefined ? {} : { recall }),
    flagRate: samples.length ? flagged / samples.length : 0,
  };
}

export function sweep(samples: readonly ScoredSample[], thresholds: readonly number[]): ThresholdRow[] {
  return thresholds.map(threshold => metricsAt(samples, threshold));
}

/** The distinct scores, ascending, as a threshold grid: every point where the counts can change. */
export function defaultThresholds(samples: readonly ScoredSample[], limit = 64): number[] {
  const distinct = [...new Set(samples.map(sample => sample.score))].sort((a, b) => a - b);
  if (distinct.length <= limit) return distinct;
  const step = (distinct.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => distinct[Math.round(index * step)] as number);
}

/**
 * The lowest threshold that clears the precision and recall floors. With no floors, the best F1 among the rows;
 * undefined when nothing clears them.
 */
export function pickThreshold(rows: readonly ThresholdRow[], options: { minPrecision?: number; minRecall?: number } = {}): ThresholdRow | undefined {
  const { minPrecision, minRecall } = options;
  if (minPrecision === undefined && minRecall === undefined) {
    let best: ThresholdRow | undefined;
    let bestF1 = -1;
    for (const row of rows) {
      if (row.precision === undefined || row.recall === undefined) continue;
      const f1 = row.precision + row.recall === 0 ? 0 : 2 * row.precision * row.recall / (row.precision + row.recall);
      if (f1 > bestF1) { bestF1 = f1; best = row; }
    }
    return best;
  }
  const candidates = rows
    .filter(row => (minPrecision === undefined || (row.precision ?? 0) >= minPrecision) && (minRecall === undefined || (row.recall ?? 0) >= minRecall))
    .sort((a, b) => a.threshold - b.threshold);
  return candidates[0];
}

/** Label, score, and read the numbers: AUC, the threshold sweep, and one recommendation. */
export function calibrate(name: string, samples: readonly ScoredSample[], options: CalibrateOptions = {}): Calibration {
  const thresholds = options.thresholds ?? defaultThresholds(samples);
  const rows = sweep(samples, thresholds);
  const recommendation = pickThreshold(rows, {
    ...(options.minPrecision === undefined ? {} : { minPrecision: options.minPrecision }),
    ...(options.minRecall === undefined ? {} : { minRecall: options.minRecall }),
  });
  const rank = auc(samples);
  const threshold = recommendation?.threshold;
  return {
    name,
    scored: samples.length,
    positives: samples.filter(sample => sample.label).length,
    negatives: samples.filter(sample => !sample.label).length,
    errors: options.errors ?? 0,
    ...(rank === undefined ? {} : { auc: rank }),
    rows,
    ...(recommendation === undefined ? {} : { recommended: recommendation }),
    missed: threshold === undefined ? [] : samples.filter(sample => sample.label && sample.score < threshold),
    flagged: threshold === undefined ? [] : samples.filter(sample => !sample.label && sample.score >= threshold),
  };
}

const percent = (value: number | undefined) => value === undefined ? "-" : `${(value * 100).toFixed(0)}%`;

/** Plain text, no colour: safe to write to a report file or a log. */
export function formatCalibration(calibration: Calibration): string {
  const lines = [
    `${calibration.name}: ${calibration.scored} scored, ${calibration.positives} positives, ${calibration.negatives} negatives${calibration.errors ? `, ${calibration.errors} errors` : ""}`,
    `AUC ${calibration.auc === undefined ? "-" : calibration.auc.toFixed(3)}`,
    "threshold  flagged  TP  FP  FN  TN  precision  recall",
  ];
  for (const row of calibration.rows) {
    lines.push(`${row.threshold.toFixed(2).padStart(9)}  ${String(row.flagged).padStart(7)}  ${String(row.tp).padStart(2)}  ${String(row.fp).padStart(2)}  ${String(row.fn).padStart(2)}  ${String(row.tn).padStart(2)}  ${percent(row.precision).padStart(9)}  ${percent(row.recall).padStart(6)}`);
  }
  const recommended = calibration.recommended;
  lines.push(recommended === undefined
    ? "recommended: none (no threshold clears the floors)"
    : `recommended ${recommended.threshold.toFixed(2)}: precision ${percent(recommended.precision)}, recall ${percent(recommended.recall)}, flags ${percent(recommended.flagRate)}`);
  if (calibration.missed.length) lines.push(`missed positives (${calibration.missed.length}): ${calibration.missed.map(sample => sample.id ?? sample.score.toFixed(2)).join(", ").slice(0, 300)}`);
  if (calibration.flagged.length) lines.push(`flagged negatives (${calibration.flagged.length}): ${calibration.flagged.map(sample => sample.id ?? sample.score.toFixed(2)).join(", ").slice(0, 300)}`);
  return lines.join("\n");
}

/** One labelled replay case: the truth, plus whatever the scorer needs to judge it. */
export interface ReplayCase<T> {
  readonly id: string;
  readonly label: boolean;
  readonly data: T;
}

export interface ReplayResult<T> {
  readonly id: string;
  readonly label: boolean;
  readonly data: T;
  /** The judge's number, absent when the case could not be scored. */
  readonly score?: number;
  /** The failure message, absent on success. Carries no upstream body. */
  readonly error?: string;
  /** True when the case was never submitted (abort or a stopped batch). */
  readonly skipped: boolean;
}

export interface ReplayOptions {
  /** Cases in flight at once. Default: DEFAULT_CONCURRENCY (4). */
  concurrency?: number;
  signal?: AbortSignal;
  /** Stop launching new cases once this returns true for a failure, e.g. a `budget` error. */
  stopOn?: (error: unknown) => boolean;
  /** Turns a thrown scorer error into the reported message. Default: the error's own message. */
  describeError?: (error: unknown) => string;
}

/**
 * Replay labelled cases through a scorer with bounded concurrency, keeping order and capturing per-case failures.
 * The scorer is usually one Jev question; a thrown error is recorded rather than aborting the run, so one bad case
 * cannot destroy a long calibration. Results feed straight into `samplesOf` and `calibrate`.
 */
export async function replay<T>(cases: readonly ReplayCase<T>[], score: (data: T, index: number) => Promise<number>, options: ReplayOptions = {}): Promise<ReplayResult<T>[]> {
  const settled: Settled<number>[] = await fanOut(cases, (item, index) => score(item.data, index), {
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.stopOn === undefined ? {} : { stopOn: options.stopOn }),
  });
  return settled.map((result, index) => {
    const item = cases[index] as ReplayCase<T>;
    if (result.ok) return { id: item.id, label: item.label, data: item.data, score: result.value, skipped: false };
    const error = options.describeError ? options.describeError(result.error) : result.error instanceof Error ? result.error.message : "The scorer failed.";
    return { id: item.id, label: item.label, data: item.data, error, skipped: result.skipped };
  });
}

/** The scored cases of a replay, in replay order. Unscored cases are excluded and counted as errors. */
export function samplesOf<T>(results: readonly ReplayResult<T>[]): { samples: ScoredSample[]; errors: number } {
  const samples: ScoredSample[] = [];
  let errors = 0;
  for (const result of results) {
    if (result.score === undefined || !Number.isFinite(result.score)) { errors++; continue; }
    samples.push({ label: result.label, score: result.score, id: result.id });
  }
  return { samples, errors };
}
