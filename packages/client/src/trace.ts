// The observability contract the live-run overlay and dashboard consume. These
// mirror the runtime's internal trace shape (packages/runtime/src/trace.ts) but
// live here because this is the *wire* contract — a runtime server maps its
// internal events onto these, and the browser never imports the Node-only
// runtime. `reduceTrace` folds the live event stream into a renderable timeline
// one event at a time, which suits an incrementally-updating UI.

export type RunStatus = "running" | "suspended" | "completed" | "failed";
export type StepStatus = "running" | "completed" | "failed";

export type TraceEvent =
  | { type: "run.started"; runId: string; at: number; input: unknown }
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
    }
  | { type: "run.completed"; runId: string; at: number; output: unknown }
  | { type: "run.failed"; runId: string; at: number; error: string };

/** One step in a run's timeline. `stepKey` is the durable step key; the mock
 *  client sets it to the canvas node id so an overlay can map steps to nodes. */
export interface StepTrace {
  stepKey: string;
  label: string;
  status: StepStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
}

/** A run's timeline — what an observability surface renders. */
export interface RunTrace {
  runId: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  startedAt?: number;
  finishedAt?: number;
  steps: StepTrace[];
}

/** The initial trace for a freshly triggered run, before any event arrives. */
export function startTrace(runId: string, input: unknown): RunTrace {
  return { runId, status: "running", input, steps: [] };
}

/** Apply one trace event to a trace, returning a new trace (never mutates). */
export function reduceTrace(trace: RunTrace, event: TraceEvent): RunTrace {
  switch (event.type) {
    case "run.started":
      return { ...trace, status: "running", input: event.input, startedAt: event.at };
    case "step.started":
      return {
        ...trace,
        steps: [...trace.steps, { stepKey: event.stepKey, label: event.label, status: "running", startedAt: event.at }],
      };
    case "step.completed":
      return { ...trace, steps: closeStep(trace.steps, event.stepKey, { status: "completed", finishedAt: event.at, durationMs: event.durationMs, result: event.result }) };
    case "step.failed":
      return { ...trace, steps: closeStep(trace.steps, event.stepKey, { status: "failed", finishedAt: event.at, durationMs: event.durationMs, error: event.error }) };
    case "run.completed":
      return { ...trace, status: "completed", output: event.output, finishedAt: event.at };
    case "run.failed":
      return { ...trace, status: "failed", finishedAt: event.at };
  }
}

function closeStep(steps: StepTrace[], stepKey: string, patch: Partial<StepTrace>): StepTrace[] {
  let done = false;
  return steps.map((s) => {
    if (done || s.stepKey !== stepKey || s.status !== "running") return s;
    done = true;
    return { ...s, ...patch };
  });
}
