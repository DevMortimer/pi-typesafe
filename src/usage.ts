import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piTypesafeDir } from "./credentials.js";

/**
 * TypeSafe bills input tokens only; output is free. The default mirrors the $42-per-billion-input-token rate the README
 * quotes, so a spend cap means something before anyone configures a price. Override it when the rate changes.
 */
export const DEFAULT_USD_PER_MTOK = 0.042;
/** Ledger days kept on disk; older entries are dropped on the next write. */
const KEEP_DAYS = 31;
const USAGE_VERSION = 1;

/** Counters for one window (a session, or one local day). */
export interface UsageTotals {
  readonly requestsStarted: number;
  readonly requestsSucceeded: number;
  readonly requestsFailed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One day of persisted totals plus the cost estimate for that day. */
export interface UsageReport extends UsageTotals {
  readonly day: string;
  readonly estimatedUsd: number;
}

/**
 * Client-side spend caps. Every field is optional; an absent field is unlimited. Session caps come from the client
 * options only; day caps also read the `PI_TYPESAFE_MAX_*` environment variables so a headless run can bound itself
 * without editing code. A cap that is reached raises a `budget` error before the next request leaves the process.
 */
export interface SpendCaps {
  readonly maxRequests?: number;
  readonly maxRequestsPerDay?: number;
  readonly maxInputTokensPerDay?: number;
  readonly maxUsdPerDay?: number;
}

/** The cap that stops the next request, with what it allows and what has been used today. */
export interface BlockedCap {
  readonly cap: "requestsPerDay" | "inputTokensPerDay" | "usdPerDay";
  readonly limit: number;
  readonly used: number;
  readonly day: string;
}

interface LedgerFile {
  readonly version: number;
  readonly days: Record<string, UsageTotals>;
}

export function localDay(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The stored ledger. Alongside the key store so one directory holds every pi-typesafe file. */
export function usagePath(): string {
  return join(piTypesafeDir(), "usage.json");
}

/** Input-token cost, rounded to a micro-dollar so the number stays readable. */
export function estimateUsd(inputTokens: number, usdPerMTok: number): number {
  return Math.round((inputTokens * usdPerMTok) / 1e6 * 1e6) / 1e6;
}

export function emptyTotals(): UsageTotals {
  return { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0 };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function totalsOf(value: unknown): UsageTotals {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    requestsStarted: count(raw.requestsStarted),
    requestsSucceeded: count(raw.requestsSucceeded),
    requestsFailed: count(raw.requestsFailed),
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
  };
}

function readDays(path: string): Record<string, UsageTotals> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const days = parsed && typeof parsed === "object" ? (parsed as { days?: unknown }).days : undefined;
    if (!days || typeof days !== "object" || Array.isArray(days)) return {};
    const result: Record<string, UsageTotals> = {};
    for (const [day, totals] of Object.entries(days as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) result[day] = totalsOf(totals);
    }
    return result;
  } catch {
    // A missing, unreadable, or corrupt ledger restarts today's count; it never blocks a request.
    return {};
  }
}

function keepRecent(days: Record<string, UsageTotals>, today: string): Record<string, UsageTotals> {
  const names = Object.keys(days).sort();
  const result: Record<string, UsageTotals> = {};
  for (const name of names.slice(-KEEP_DAYS)) result[name] = days[name] as UsageTotals;
  result[today] = days[today] ?? emptyTotals();
  return result;
}

/** Owner-only, atomic, and best-effort: a ledger this process cannot write never fails a request. */
function writeDays(path: string, days: Record<string, UsageTotals>): void {
  const file: LedgerFile = { version: USAGE_VERSION, days };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup only */ }
  }
}

/** The caps a headless run may set without code: `PI_TYPESAFE_MAX_USD_PER_DAY` and its siblings. */
export function capsFromEnvironment(env: NodeJS.ProcessEnv = process.env): SpendCaps {
  const number = (name: string): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const maxRequestsPerDay = number("PI_TYPESAFE_MAX_REQUESTS_PER_DAY");
  const maxInputTokensPerDay = number("PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY");
  const maxUsdPerDay = number("PI_TYPESAFE_MAX_USD_PER_DAY");
  return {
    ...(maxRequestsPerDay === undefined ? {} : { maxRequestsPerDay: Math.floor(maxRequestsPerDay) }),
    ...(maxInputTokensPerDay === undefined ? {} : { maxInputTokensPerDay: Math.floor(maxInputTokensPerDay) }),
    ...(maxUsdPerDay === undefined ? {} : { maxUsdPerDay }),
  };
}

/** Environment first for day caps, then the explicit option; a cap is never raised by the environment. */
export function mergeCaps(explicit: SpendCaps, environment: SpendCaps): SpendCaps {
  const lowest = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
  const maxRequestsPerDay = lowest(explicit.maxRequestsPerDay, environment.maxRequestsPerDay);
  const maxInputTokensPerDay = lowest(explicit.maxInputTokensPerDay, environment.maxInputTokensPerDay);
  const maxUsdPerDay = lowest(explicit.maxUsdPerDay, environment.maxUsdPerDay);
  return {
    ...(explicit.maxRequests === undefined ? {} : { maxRequests: explicit.maxRequests }),
    ...(maxRequestsPerDay === undefined ? {} : { maxRequestsPerDay }),
    ...(maxInputTokensPerDay === undefined ? {} : { maxInputTokensPerDay }),
    ...(maxUsdPerDay === undefined ? {} : { maxUsdPerDay }),
  };
}

export interface UsageLedgerOptions {
  /** Defaults to usagePath(); tests point it at a temporary file. */
  path?: string;
  /** Clock for the local day and for rollover; injectable for tests. */
  now?: () => Date;
  usdPerMTok?: number;
}

/**
 * One day of persisted request, token, and cost totals, plus the caps that stop the next request. The in-memory copy is
 * authoritative for this process; the file is the cross-process, across-restart record. Reads are defensive, writes are
 * atomic and best-effort, and a day rolls over on the local date, so a long eval cannot accumulate forever unnoticed.
 */
export interface UsageLedger {
  readonly path: string;
  readonly usdPerMTok: number;
  /** Today's totals, after any rollover. */
  today(): UsageReport;
  /** Count the attempt before it is submitted; a request that never returns still counts. */
  recordStart(): void;
  recordSuccess(inputTokens: number, outputTokens: number): void;
  recordFailure(): void;
  /** The reached day cap that blocks the next request, or undefined. The caller owns the caps. */
  blocked(caps: SpendCaps): BlockedCap | undefined;
  /** One line for status output: today's requests, tokens, and cost, with the caps that apply. */
  describe(caps?: SpendCaps): string;
}

export function openUsageLedger(options: UsageLedgerOptions = {}): UsageLedger {
  const path = options.path ?? usagePath();
  const now = options.now ?? (() => new Date());
  const usdPerMTok = options.usdPerMTok && options.usdPerMTok > 0 ? options.usdPerMTok : DEFAULT_USD_PER_MTOK;
  let day = localDay(now());
  let days = keepRecent(readDays(path), day);
  let totals = days[day] as UsageTotals;

  const report = (value: UsageTotals, name: string): UsageReport => ({
    ...value, day: name, estimatedUsd: estimateUsd(value.inputTokens, usdPerMTok),
  });

  const save = () => {
    days = keepRecent({ ...days, [day]: totals }, day);
    writeDays(path, days);
  };

  const roll = () => {
    const current = localDay(now());
    if (current === day) return;
    day = current;
    totals = days[day] ?? emptyTotals();
    days = keepRecent(days, day);
  };

  const add = (delta: Partial<UsageTotals>) => {
    roll();
    totals = {
      requestsStarted: totals.requestsStarted + (delta.requestsStarted ?? 0),
      requestsSucceeded: totals.requestsSucceeded + (delta.requestsSucceeded ?? 0),
      requestsFailed: totals.requestsFailed + (delta.requestsFailed ?? 0),
      inputTokens: totals.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: totals.outputTokens + (delta.outputTokens ?? 0),
    };
    save();
  };

  return {
    path,
    usdPerMTok,
    today: () => { roll(); return report(totals, day); },
    recordStart: () => add({ requestsStarted: 1 }),
    recordSuccess: (inputTokens, outputTokens) => add({
      requestsSucceeded: 1,
      inputTokens: Number.isSafeInteger(inputTokens) && inputTokens > 0 ? inputTokens : 0,
      outputTokens: Number.isSafeInteger(outputTokens) && outputTokens > 0 ? outputTokens : 0,
    }),
    recordFailure: () => add({ requestsFailed: 1 }),
    blocked: (caps: SpendCaps) => {
      roll();
      const checks: Array<[BlockedCap["cap"], number | undefined, number]> = [
        ["requestsPerDay", caps.maxRequestsPerDay, totals.requestsStarted],
        ["inputTokensPerDay", caps.maxInputTokensPerDay, totals.inputTokens],
        ["usdPerDay", caps.maxUsdPerDay, estimateUsd(totals.inputTokens, usdPerMTok)],
      ];
      for (const [cap, limit, used] of checks) {
        if (limit !== undefined && used >= limit) return { cap, limit, used, day };
      }
      return undefined;
    },
    describe: (caps: SpendCaps = {}) => {
      roll();
      const current = report(totals, day);
      const limits = [
        caps.maxRequestsPerDay === undefined ? undefined : `${current.requestsStarted}/${caps.maxRequestsPerDay} requests`,
        caps.maxInputTokensPerDay === undefined ? undefined : `${current.inputTokens}/${caps.maxInputTokensPerDay} input tokens`,
        caps.maxUsdPerDay === undefined ? undefined : `$${current.estimatedUsd.toFixed(4)}/$${caps.maxUsdPerDay.toFixed(2)}`,
      ].filter((part): part is string => part !== undefined);
      return `${current.requestsStarted} requests today (${current.requestsSucceeded} ok, ${current.requestsFailed} failed), ${current.inputTokens} input / ${current.outputTokens} output tokens, ~$${current.estimatedUsd.toFixed(4)}${limits.length ? `; caps ${limits.join(", ")}` : "; no daily cap"}`;
    },
  };
}
