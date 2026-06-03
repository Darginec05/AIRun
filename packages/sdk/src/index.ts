// @airun/sdk — the hand-written primitive surface (the product moat).
//
// This file is the authoring surface: the types the compiler targets plus thin
// primitive implementations. The primitives carry no durability logic of their
// own — they delegate to the RuntimeAdapter bound for the current run (see the
// "runtime binding" section at the bottom). The hard 90% (step journal, replay,
// retries, approvals, the agent loop) lives in @airun/runtime, which installs an
// adapter via installRuntimeResolver(). Outside a run, the primitives throw.
//
// Factories that run at module-load time (tool.*, state, trigger) return
// descriptors/handles; their *operations* delegate to the adapter at call time,
// so a `const t = tool.http(...)` at module scope is fine and only `await t(...)`
// inside a run touches the runtime.
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

export type TriggerDescriptor =
  | { kind: "event"; eventName: string }
  | { kind: "schedule"; cron: string; timezone?: string }
  | { kind: "webhook"; path: string; method: HttpMethod };

export interface Trigger<TPayload> {
  readonly _payload?: TPayload;
  readonly descriptor: TriggerDescriptor;
}

export interface ScheduleTick {
  scheduledAt: string;
}

export interface TriggerApi {
  /** Event payload is typed from the schema when provided. */
  onEvent<T = unknown>(eventName: string, schema?: Schema<T>): Trigger<T>;
  onSchedule(cron: string, opts?: { timezone?: string }): Trigger<ScheduleTick>;
  onWebhook<T = unknown>(opts: {
    path: string;
    method: HttpMethod;
    schema?: Schema<T>;
  }): Trigger<T>;
}

// Triggers don't execute during a run — the runtime delivers the payload as
// ctx.event. The descriptor is captured for the (future) scheduler/dispatcher.
function makeTrigger<T>(descriptor: TriggerDescriptor): Trigger<T> {
  return { descriptor } as Trigger<T>;
}

export const trigger: TriggerApi = {
  onEvent: <T = unknown>(eventName: string): Trigger<T> =>
    makeTrigger<T>({ kind: "event", eventName }),
  onSchedule: (cron: string, opts?: { timezone?: string }): Trigger<ScheduleTick> =>
    makeTrigger<ScheduleTick>({ kind: "schedule", cron, timezone: opts?.timezone }),
  onWebhook: <T = unknown>(opts: { path: string; method: HttpMethod }): Trigger<T> =>
    makeTrigger<T>({ kind: "webhook", path: opts.path, method: opts.method }),
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

function makeTool<TArgs, TResult>(def: ToolDescriptor<TArgs, TResult>): Tool<TArgs, TResult> {
  const invoke = (args: TArgs): Promise<TResult> => currentRuntime().callTool(def, args);
  return Object.assign(invoke, { id: def.id });
}

export const tool: ToolFactory = {
  http: (opts) => makeTool({ kind: "http", ...opts }),
  fn: (opts) => makeTool({ kind: "fn", ...opts }),
};

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

export const stop: {
  maxSteps(value: number): StopWhen;
  noToolUse(): StopWhen;
  toolCalled(tool: Tool): StopWhen;
} = {
  maxSteps: (value) => ({ kind: "maxSteps", value }),
  noToolUse: () => ({ kind: "noToolUse" }),
  toolCalled: (t) => ({ kind: "toolCalled", tool: t }),
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

export const ai: AI = {
  generate: ((opts: GenerateTextOptions | GenerateObjectOptions<unknown>): Promise<unknown> =>
    currentRuntime().generate(opts)) as AI["generate"],
  classify: (opts) => currentRuntime().classify(opts),
  agent: ((opts: AgentOptions<unknown>): Promise<unknown> =>
    currentRuntime().agent(opts)) as AI["agent"],
};

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

export const step: Step = {
  run: (name, fn) => currentRuntime().stepRun(name, fn),
  // transform is a pure, synchronous data transform — no durability needed.
  transform: (input, fn) => fn(input),
  route: async ({ input, routes, fallback }) => {
    const key = String(input);
    const branch = (routes as Record<string, () => Promise<void> | void>)[key] ?? fallback;
    if (branch) await branch();
  },
  parallel: (branches) =>
    Promise.all((branches as ReadonlyArray<() => Promise<unknown>>).map((b) => b())) as Promise<never>,
  parallelMap: async (collection, body, opts) => {
    const results: Awaited<ReturnType<typeof body>>[] = new Array(collection.length);
    const lanes = Math.max(1, Math.min(opts?.maxConcurrency ?? collection.length, collection.length));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < collection.length) {
        const i = cursor++;
        results[i] = await body(collection[i]!, i);
      }
    };
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return results;
  },
  approval: (opts) => currentRuntime().approval(opts),
  input: (opts) => currentRuntime().input(opts),
  invoke: (workflow, input) => currentRuntime().invoke(workflow, input),
  forEach: async (collection, body) => {
    for (let i = 0; i < collection.length; i++) await body(collection[i]!, i);
  },
  while: async (condition, body, opts) => {
    const max = opts?.maxIterations ?? Number.POSITIVE_INFINITY;
    let iterations = 0;
    while (await condition()) {
      if (iterations++ >= max) break;
      await body();
    }
  },
};

// ---------------------------------------------------------------------------
// state.* — run / session / persistent
// ---------------------------------------------------------------------------

export type StateScope = "run" | "session" | "persistent";

export interface StateOpts<T> {
  scope: StateScope;
  initial?: T;
}

export interface StateHandle<T> {
  get(): Promise<T>;
  set(value: T): Promise<void>;
  append(item: T extends (infer E)[] ? E : never): Promise<void>;
  merge(partial: Partial<T>): Promise<void>;
}

export interface StateFactory {
  <T>(name: string, opts: StateOpts<T>): StateHandle<T>;
}

export const state: StateFactory = <T>(name: string, opts: StateOpts<T>): StateHandle<T> => ({
  get: () => currentRuntime().stateGet<T>(name, opts),
  set: (value) => currentRuntime().stateSet<T>(name, opts, value),
  append: (item) => currentRuntime().stateAppend<T>(name, opts, item),
  merge: (partial) => currentRuntime().stateMerge<T>(name, opts, partial),
});

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

const workflowRegistry = new WeakMap<WorkflowRef<unknown, unknown>, WorkflowDef<unknown, unknown>>();

export function defineWorkflow<TPayload, TOutput>(
  def: WorkflowDef<TPayload, TOutput>,
): WorkflowRef<TPayload, TOutput> {
  const ref: WorkflowRef<TPayload, TOutput> = { id: def.id };
  workflowRegistry.set(
    ref as WorkflowRef<unknown, unknown>,
    def as unknown as WorkflowDef<unknown, unknown>,
  );
  return ref;
}

/** The runtime reads the captured def to execute a workflow by reference. */
export function getWorkflowDef<TPayload, TOutput>(
  ref: WorkflowRef<TPayload, TOutput>,
): WorkflowDef<TPayload, TOutput> | undefined {
  return workflowRegistry.get(ref as WorkflowRef<unknown, unknown>) as
    | WorkflowDef<TPayload, TOutput>
    | undefined;
}

// ---------------------------------------------------------------------------
// Runtime binding
// ---------------------------------------------------------------------------
//
// The primitives above are thin: each durable operation delegates to the
// RuntimeAdapter bound for the current run. @airun/runtime installs a resolver
// (backed by AsyncLocalStorage) via installRuntimeResolver(); the SDK itself
// stays free of any Node dependency. Outside a run, currentRuntime() throws.

/** A tool's captured configuration; the runtime invokes it as a durable step. */
export type ToolDescriptor<TArgs, TResult> =
  | {
      kind: "http";
      id: string;
      name?: string;
      description?: string;
      method: HttpMethod;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: (args: TArgs) => unknown;
      auth?: { secret: string };
    }
  | {
      kind: "fn";
      id: string;
      name?: string;
      description?: string;
      handler: (args: TArgs) => Promise<TResult> | TResult;
    };

/**
 * The operations the SDK primitives delegate to. @airun/runtime implements this
 * with a step journal (durability), the agent loop, retries, approvals and
 * state. Everything here runs inside an active workflow run.
 */
export interface RuntimeAdapter {
  stepRun<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  callTool<TArgs, TResult>(def: ToolDescriptor<TArgs, TResult>, args: TArgs): Promise<TResult>;
  generate<T>(opts: GenerateTextOptions | GenerateObjectOptions<T>): Promise<T | string>;
  classify<L extends string>(opts: {
    model: string;
    input: string;
    labels: readonly L[];
    instructions?: string;
  }): Promise<L>;
  agent<T>(opts: AgentOptions<T>): Promise<T | string>;
  approval(opts: ApprovalOptions): Promise<ApprovalResult>;
  input<T extends Record<string, unknown>>(opts: {
    prompt: string;
    fields: { [K in keyof T]: FieldSpec<T[K]> };
    assignee?: string;
    timeout?: Duration;
  }): Promise<T>;
  invoke<TInput, TOutput>(ref: WorkflowRef<TInput, TOutput>, input: TInput): Promise<TOutput>;
  stateGet<T>(name: string, opts: StateOpts<T>): Promise<T>;
  stateSet<T>(name: string, opts: StateOpts<T>, value: T): Promise<void>;
  stateAppend<T>(name: string, opts: StateOpts<T>, item: unknown): Promise<void>;
  stateMerge<T>(name: string, opts: StateOpts<T>, partial: unknown): Promise<void>;
}

let runtimeResolver: (() => RuntimeAdapter) | null = null;

/** Called once by @airun/runtime to wire the active-run adapter lookup. */
export function installRuntimeResolver(resolver: () => RuntimeAdapter): void {
  runtimeResolver = resolver;
}

/** The adapter for the current run, or a thrown error if called outside one. */
export function currentRuntime(): RuntimeAdapter {
  if (!runtimeResolver) {
    throw new Error(
      "No @airun/runtime bound. Execute workflows via @airun/runtime's runWorkflow(); SDK primitives cannot run standalone.",
    );
  }
  return runtimeResolver();
}
