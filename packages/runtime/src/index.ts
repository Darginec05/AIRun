// @airun/runtime — the durable execution engine.
//
// Generated workflows import their primitives from @airun/sdk; this package
// installs the adapter those primitives delegate to. A step journal records
// every completed step so replays serve them instead of re-executing, which is
// what makes side effects fire once and approval/input waits survive restarts.
// v1 ships an in-memory journal behind the Journal port; a Postgres adapter is
// the next step against the same interface.

export { createRuntime } from "./run.js";
export type { Runtime, RunResult } from "./run.js";

export { InMemoryJournal } from "./journal.js";
export type { Journal, RunRecord, RunStatus, StepLookup } from "./journal.js";

export { Suspended } from "./context.js";
export type { PendingWait, RunDeps } from "./context.js";

export {
  envSecretResolver,
  fetchHttpClient,
  stubModelClient,
} from "./ports.js";
export type {
  AgentDecision,
  AgentStepRequest,
  AgentTurn,
  ClassifyRequest,
  GenerateRequest,
  HttpClient,
  HttpRequest,
  HttpResponse,
  ModelClient,
  SecretResolver,
} from "./ports.js";
