// Observability traces — the second payoff of the step journal (§14). Every run
// emits an append-only event stream: run lifecycle plus per-step timings, status
// and payloads. The same journal that makes execution durable is the source of
// truth here, so a run can be replayed *and* watched. Trace events are pure
// observability — they never feed replay, so wall-clock timing is fine.

import type { Journal, RunRecord, RunStatus } from "./journal.js";

export type TraceEvent =
  | { type: "run.started"; runId: string; at: number; input: unknown }
  | { type: "run.resumed"; runId: string; at: number; stepKey: string }
  | { type: "run.suspended"; runId: string; at: number; waits: { kind: string; stepKey: string }[] }
  | { type: "run.completed"; runId: string; at: number; output: unknown }
  | { type: "run.failed"; runId: string; at: number; error: string }
  | { type: "step.started"; runId: string; at: number; stepKey: string; label: string }
  | {
      type: "step.completed";
      runId: string;
      at: number;
      stepKey: string;
      label: string;
      durationMs: number;
      result: unknown;
    }
  | {
      type: "step.failed";
      runId: string;
      at: number;
      stepKey: string;
      label: string;
      durationMs: number;
      error: string;
    };

/** One executed durable step, as seen in a run's trace. */
export interface StepTrace {
  stepKey: string;
  label: string;
  status: "completed" | "failed";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  result?: unknown;
  error?: string;
}

/** A run's assembled timeline — what an observability surface renders. */
export interface RunTrace {
  runId: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  startedAt?: number;
  finishedAt?: number;
  steps: StepTrace[];
}

/** Persist a trace event and notify the live sink, if any. */
export async function emitTrace(
  deps: { journal: Journal; onTrace?: (event: TraceEvent) => void },
  event: TraceEvent,
): Promise<void> {
  await deps.journal.appendEvent(event.runId, event);
  if (deps.onTrace) {
    try {
      deps.onTrace(event);
    } catch {
      // A faulty observability sink must never break a run.
    }
  }
}

/** Fold a run's event stream into a renderable timeline. */
export function assembleTrace(record: RunRecord, events: readonly TraceEvent[]): RunTrace {
  const steps: StepTrace[] = [];
  const startedByKey = new Map<string, number>();
  let startedAt: number | undefined;
  let finishedAt: number | undefined;

  for (const e of events) {
    switch (e.type) {
      case "run.started":
        startedAt = e.at;
        break;
      case "run.completed":
      case "run.failed":
        finishedAt = e.at;
        break;
      case "step.started":
        startedByKey.set(e.stepKey, e.at);
        break;
      case "step.completed":
        steps.push({
          stepKey: e.stepKey,
          label: e.label,
          status: "completed",
          startedAt: startedByKey.get(e.stepKey) ?? e.at,
          finishedAt: e.at,
          durationMs: e.durationMs,
          result: e.result,
        });
        break;
      case "step.failed":
        steps.push({
          stepKey: e.stepKey,
          label: e.label,
          status: "failed",
          startedAt: startedByKey.get(e.stepKey) ?? e.at,
          finishedAt: e.at,
          durationMs: e.durationMs,
          error: e.error,
        });
        break;
    }
  }

  const trace: RunTrace = { runId: record.runId, status: record.status, input: record.input, steps };
  if (record.output !== undefined) trace.output = record.output;
  if (startedAt !== undefined) trace.startedAt = startedAt;
  if (finishedAt !== undefined) trace.finishedAt = finishedAt;
  return trace;
}

/** Normalize a thrown value to a message string for trace events. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
