// Per-run execution context. It is rebuilt for every attempt (initial run and
// each replay after a wait is delivered) and carries the run id, the injected
// dependencies, the deterministic step-key allocator and the waits discovered
// during the current attempt.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Duration, RuntimeAdapter } from "@airun/sdk";
import type { Journal } from "./journal.js";
import type { HttpClient, ModelClient, SecretResolver } from "./ports.js";
import { emitTrace } from "./trace.js";
import type { TraceEvent } from "./trace.js";

export interface RunDeps {
  journal: Journal;
  model: ModelClient;
  http: HttpClient;
  secrets: SecretResolver;
  /** Optional live observability sink; receives each trace event as it is emitted. */
  onTrace?: (event: TraceEvent) => void;
}

/** A human-in-the-loop wait surfaced when its result has not been delivered yet. */
export type PendingWait =
  | { kind: "approval"; stepKey: string; prompt: string; assignee?: string; timeout?: Duration }
  | {
      kind: "input";
      stepKey: string;
      prompt: string;
      fields: Record<string, unknown>;
      assignee?: string;
      timeout?: Duration;
    };

/** Step-key labels for human-in-the-loop waits — the only keys resume() may deliver. */
export const WAIT_STEP_LABELS = {
  approval: "step.approval",
  input: "step.input",
} as const;

/** True when a step key was produced by an approval/input wait. */
export function isWaitStepKey(stepKey: string): boolean {
  return Object.values(WAIT_STEP_LABELS).some((label) => stepKey.startsWith(`${label}#`));
}

/** Thrown by a wait whose result is not yet in the journal; unwinds the attempt. */
export class Suspended extends Error {
  constructor(public readonly stepKey: string) {
    super(`workflow suspended at ${stepKey}`);
    this.name = "Suspended";
  }
}

export class RunContext {
  readonly waits: PendingWait[] = [];
  private readonly ordinals = new Map<string, number>();

  constructor(
    readonly runId: string,
    readonly deps: RunDeps,
  ) {}

  /**
   * A stable key for a durable step. Replays walk the same code path and call
   * this in the same order, so the per-label ordinal reproduces the same keys.
   */
  nextStepKey(label: string): string {
    const n = (this.ordinals.get(label) ?? 0) + 1;
    this.ordinals.set(label, n);
    return `${label}#${n}`;
  }

  /** Persist a trace event for this run and notify the live sink. */
  trace(event: TraceEvent): Promise<void> {
    return emitTrace(this.deps, event);
  }
}

interface RunStore {
  adapter: RuntimeAdapter;
}

const storage = new AsyncLocalStorage<RunStore>();

export function runWithin<T>(adapter: RuntimeAdapter, fn: () => Promise<T>): Promise<T> {
  return storage.run({ adapter }, fn);
}

/** Resolver installed into the SDK so its primitives find the active adapter. */
export function activeAdapter(): RuntimeAdapter {
  const store = storage.getStore();
  if (!store) {
    throw new Error("No active @airun/runtime run. SDK primitives were called outside runWorkflow().");
  }
  return store.adapter;
}
