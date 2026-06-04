// @airun/client — typed client for the runtime / cloud API.
//
// Trigger runs and stream live execution traces. Slice 1 ships the typed surface
// (RunClient/RunHandle), the observability contract (TraceEvent/RunTrace + an
// incremental reducer), and a browser-side mock client that fabricates a trace
// from a graph for the live-run overlay. A real HTTP/SSE client lands once a
// runtime server exists.

export type { RunClient, RunHandle } from "./client.js";
export { createMockRunClient } from "./mock.js";
export type { MockRunOptions } from "./mock.js";
export { reduceTrace, startTrace } from "./trace.js";
export type { RunStatus, RunTrace, StepStatus, StepTrace, TraceEvent } from "./trace.js";
