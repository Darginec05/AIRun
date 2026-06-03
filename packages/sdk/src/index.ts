// @airun/sdk — the hand-written primitive surface (the product moat).
//
// This file is the SURFACE only: types plus `declare`d bindings. No runtime
// implementation yet — the agent loop, durability, retries and approvals will be
// implemented here (and in @airun/runtime), not in generated code. Because the
// symbols are `declare`d, this module emits no JS, only .d.ts.
//
// The surface is deliberately aligned with the @airun/schema IR so the compiler
// can map node configs onto these primitives 1:1 (stopWhen↔StopCondition,
// state ops, Duration, trigger kinds, structured output, dynamic fan-out).

// ---------------------------------------------------------------------------
// Primitives shared with the IR
// ---------------------------------------------------------------------------

export type DurationUnit = "ms" | "s" | "m" | "h" | "d";
export type Duration = `${number}${DurationUnit}`;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A typed schema marker (zod-compatible at runtime; structurally minimal here). */
export interface Schema<T> {
  readonly _type?: T;
  parse(input: unknown): T;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}
export type Conversation = Message[];

// ---------------------------------------------------------------------------
// Triggers — onEvent / onSchedule / onWebhook (no "manual")
// ---------------------------------------------------------------------------

export interface Trigger<TPayload> {
  readonly _payload?: TPayload;
}

export interface ScheduleTick {
  scheduledAt: string;
}

export declare const trigger: {
  /** Event payload is typed from the schema when provided. */
  onEvent<T = unknown>(eventName: string, schema?: Schema<T>): Trigger<T>;
  onSchedule(cron: string, opts?: { timezone?: string }): Trigger<ScheduleTick>;
  onWebhook<T = unknown>(opts: {
    path: string;
    method: HttpMethod;
    schema?: Schema<T>;
  }): Trigger<T>;
};

// ---------------------------------------------------------------------------
// Tools — tool.http / tool.fn
// ---------------------------------------------------------------------------

/** A tool is directly invocable; each call is a durable step. */
export interface Tool<TArgs = unknown, TResult = unknown> {
  readonly id: string;
  (args: TArgs): Promise<TResult>;
}

export interface ToolFactory {
  http<TArgs = Record<string, unknown>, TResult = unknown>(opts: {
    id: string;
    name?: string;
    description?: string;
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: (args: TArgs) => unknown;
    auth?: { secret: string };
  }): Tool<TArgs, TResult>;
  fn<TArgs, TResult>(opts: {
    id: string;
    name?: string;
    description?: string;
    handler: (args: TArgs) => Promise<TResult> | TResult;
  }): Tool<TArgs, TResult>;
}

export declare const tool: ToolFactory;

// ---------------------------------------------------------------------------
// AI — generate / classify / agent
// ---------------------------------------------------------------------------

export interface GenerateTextOptions {
  model: string;
  system?: string | Conversation;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateObjectOptions<T> extends GenerateTextOptions {
  schema: Schema<T>;
}

export interface AgentStepInfo {
  step: number;
  toolCalls: number;
}

/** Mirrors IR StopCondition; `condition` is the SDK-side predicate form. */
export type StopWhen =
  | { kind: "maxSteps"; value: number }
  | { kind: "noToolUse" }
  | { kind: "toolCalled"; tool: Tool }
  | { kind: "condition"; predicate: (info: AgentStepInfo) => boolean }
  | { kind: "any"; conditions: StopWhen[] };

export declare const stop: {
  maxSteps(value: number): StopWhen;
  noToolUse(): StopWhen;
  toolCalled(tool: Tool): StopWhen;
};

export interface AgentOptions<T> {
  model: string;
  system?: string | Conversation;
  prompt: string;
  tools: Tool[];
  stopWhen: StopWhen | StopWhen[];
  schema?: Schema<T>;
}

export interface AI {
  // Object overload first so options carrying a schema resolve to T, not string.
  generate<T>(opts: GenerateObjectOptions<T>): Promise<T>;
  generate(opts: GenerateTextOptions): Promise<string>;
  classify<L extends string>(opts: {
    model: string;
    input: string;
    labels: readonly L[];
    instructions?: string;
  }): Promise<L>;
  agent<T>(opts: AgentOptions<T> & { schema: Schema<T> }): Promise<T>;
  agent(opts: AgentOptions<string> & { schema?: undefined }): Promise<string>;
}

export declare const ai: AI;

// ---------------------------------------------------------------------------
// step.* — durable units, control flow, human-in-the-loop
// ---------------------------------------------------------------------------

export interface ApprovalResult {
  approved: boolean;
  by?: string;
  comment?: string;
}

export interface ApprovalOptions {
  prompt: string;
  assignee?: string;
  timeout?: Duration;
  onTimeout?: "approve" | "reject" | "escalate";
}

export interface FieldSpec<T> {
  type: "string" | "number" | "boolean" | "json";
  label?: string;
  required?: boolean;
  default?: T;
}

export interface Step {
  /** Durable, possibly side-effecting unit. Result is journaled and replayed on restart. */
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /** Pure data transform. */
  transform<I, O>(input: I, fn: (input: I) => O): O;
  /** Rule- or LLM-based routing: runs the branch keyed by the chosen route. */
  route<K extends string>(opts: {
    input: unknown;
    routes: Record<K, () => Promise<void> | void>;
    fallback?: () => Promise<void> | void;
  }): Promise<void>;
  /** Static fan-out across a fixed set of branches. */
  parallel<T extends readonly unknown[]>(branches: {
    [K in keyof T]: () => Promise<T[K]>;
  }): Promise<T>;
  /** Dynamic fan-out (orchestrator-workers) — maps a body over a collection. */
  parallelMap<I, O>(
    collection: I[],
    body: (item: I, index: number) => Promise<O>,
    opts?: { maxConcurrency?: number },
  ): Promise<O[]>;
  /** Human approval — survives restarts via the step journal. */
  approval(opts: ApprovalOptions): Promise<ApprovalResult>;
  /** Human input — collects typed fields. */
  input<T extends Record<string, unknown>>(opts: {
    prompt: string;
    fields: { [K in keyof T]: FieldSpec<T[K]> };
    assignee?: string;
    timeout?: Duration;
  }): Promise<T>;
  /** Invoke a sub-workflow; input is validated against its trigger schema. */
  invoke<TInput, TOutput>(
    workflow: WorkflowRef<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  forEach<I>(
    collection: I[],
    body: (item: I, index: number) => Promise<void>,
  ): Promise<void>;
  while(
    condition: () => boolean | Promise<boolean>,
    body: () => Promise<void>,
    opts?: { maxIterations?: number },
  ): Promise<void>;
}

export declare const step: Step;

// ---------------------------------------------------------------------------
// state.* — run / session / persistent
// ---------------------------------------------------------------------------

export type StateScope = "run" | "session" | "persistent";

export interface StateHandle<T> {
  get(): Promise<T>;
  set(value: T): Promise<void>;
  append(item: T extends (infer E)[] ? E : never): Promise<void>;
  merge(partial: Partial<T>): Promise<void>;
}

export interface StateFactory {
  <T>(name: string, opts: { scope: StateScope; initial?: T }): StateHandle<T>;
}

export declare const state: StateFactory;

// ---------------------------------------------------------------------------
// defineWorkflow
// ---------------------------------------------------------------------------

export interface WorkflowContext<TPayload> {
  event: TPayload;
  ai: AI;
  step: Step;
  state: StateFactory;
}

export interface WorkflowRef<TInput, TOutput> {
  readonly id: string;
  readonly _input?: TInput;
  readonly _output?: TOutput;
}

export interface WorkflowDef<TPayload, TOutput> {
  id: string;
  name?: string;
  on: Trigger<TPayload>;
  run: (ctx: WorkflowContext<TPayload>) => Promise<TOutput>;
}

export declare function defineWorkflow<TPayload, TOutput>(
  def: WorkflowDef<TPayload, TOutput>,
): WorkflowRef<TPayload, TOutput>;
