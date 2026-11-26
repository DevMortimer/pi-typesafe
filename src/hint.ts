import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic.js";
import type { TypeSafeBackend } from "./backends.js";
import { piTypesafeDir } from "./credentials.js";

export const WARDEN_S1_HINT =
  "Hint: Local 128K-context noul, choice, and score evaluations run offline in <1 GB RAM with no API key via warden-s1 (/typesafe model download).";

export const WARDEN_S1_CREDIT =
  "Warden-S1 (Apache-2.0) by @devmortimer · https://x.com/devmortimer · https://ryanjoshuagapac.com/writing/warden-s1";

export type WardenS1HintState = "unshown" | "shown";

export type WardenS1HintTriggerKind =
  | "missing_cloud_key"
  | "cloud_context_limit"
  | "cloud_timeout"
  | "other";

export interface WardenS1HintTrigger {
  readonly kind: WardenS1HintTriggerKind;
  readonly backend: TypeSafeBackend;
}

export interface WardenS1HintTransition {
  readonly state: WardenS1HintState;
  readonly emit: boolean;
}

export function transitionWardenS1Hint(
  state: WardenS1HintState,
  trigger: WardenS1HintTrigger,
): WardenS1HintTransition {
  if (state === "shown") return { state: "shown", emit: false };
  if (trigger.backend === "warden-s1") return { state: "unshown", emit: false };
  if (
    trigger.kind === "missing_cloud_key"
    || trigger.kind === "cloud_context_limit"
    || trigger.kind === "cloud_timeout"
  ) {
    return { state: "shown", emit: true };
  }
  return { state: "unshown", emit: false };
}

export function extensionStatePath(): string {
  return join(piTypesafeDir(), "state.json");
}

function readStateObject(path: string): { readonly ok: true; readonly data: Record<string, unknown> } | { readonly ok: false; readonly missing: boolean } {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return { ok: true, data: raw as Record<string, unknown> };
    }
    return { ok: false, missing: false };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return { ok: false, missing: code === "ENOENT" };
  }
}

export function readWardenS1HintState(path: string = extensionStatePath()): WardenS1HintState {
  const loaded = readStateObject(path);
  if (!loaded.ok) {
    // Treat unreadable non-ENOENT state files as shown so broken permissions never cause repeated nagging.
    return loaded.missing ? "unshown" : "shown";
  }
  return loaded.data.wardenS1HintShown === true ? "shown" : "unshown";
}

export function writeWardenS1HintShown(path: string = extensionStatePath()): void {
  const loaded = readStateObject(path);
  const next = loaded.ok ? { ...loaded.data, wardenS1HintShown: true } : { wardenS1HintShown: true };
  try {
    writeFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Best-effort persistence; the in-memory mirror still prevents repeats in this session.
  }
}

export interface WardenS1HintController {
  consume(trigger: WardenS1HintTrigger): string | undefined;
}

export function createWardenS1HintController(pathFor: () => string = extensionStatePath): WardenS1HintController {
  let memoryState: WardenS1HintState = "unshown";
  return {
    consume(trigger: WardenS1HintTrigger): string | undefined {
      if (memoryState === "shown") return undefined;
      if (!transitionWardenS1Hint("unshown", trigger).emit) return undefined;
      const path = pathFor();
      const persisted = readWardenS1HintState(path);
      const next = transitionWardenS1Hint(persisted, trigger);
      memoryState = next.state;
      if (!next.emit) return undefined;
      writeWardenS1HintShown(path);
      return WARDEN_S1_HINT;
    },
  };
}
