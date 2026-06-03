// @airun/runtime — the durable execution engine.
//
// Generated workflows import their primitives from @airun/sdk; this package
// installs the adapter those primitives delegate to. A step journal records
// every completed step so replays serve them instead of re-executing, which is
// what makes side effects fire once and approval/input waits survive restarts.
// Two journal adapters ship behind the Journal port — in-memory and Postgres —
// and a real Anthropic ModelClient sits behind the model port.

export { createRuntime } from "./run.js";
export type { Runtime, RunResult } from "./run.js";

export { InMemoryJournal } from "./journal.js";
export type { Journal, RunRecord, RunStatus, StepLookup } from "./journal.js";

export { PostgresJournal, postgresJournal } from "./postgres.js";
export type { Queryable } from "./postgres.js";

export { anthropicModelClient } from "./anthropic.js";
export type { AnthropicOptions } from "./anthropic.js";

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
