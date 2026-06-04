// The client surface the builder and dashboard program against. A real
// implementation talks HTTP/SSE to a runtime server; the mock implementation in
// mock.ts drives a simulated trace entirely in the browser. Both satisfy this
// one interface so the overlay is identical regardless of backend.

import type { WorkflowGraph } from "@airun/schema";
import type { TraceEvent } from "./trace.js";

/** A live run: its id plus a way to stop streaming/executing it. */
export interface RunHandle {
  readonly runId: string;
  cancel(): void;
}

export interface RunClient {
  /**
   * Trigger a run of `graph` with `input` and stream its trace events to
   * `onEvent` as they occur. Returns a handle to cancel the run.
   */
  startRun(graph: WorkflowGraph, input: unknown, onEvent: (event: TraceEvent) => void): RunHandle;
}
