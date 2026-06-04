// The RuntimeAdapter implementation — the hard 90%. Every durable operation is
// memoized through the journal: on the first attempt it executes and records its
// result; on replay it is served from the journal instead of re-running. This is
// what makes side effects fire once, state mutate once, and approval/input waits
// survive restarts.

import type {
  AgentOptions,
  AgentStepInfo,
  ApprovalOptions,
  ApprovalResult,
  Duration,
  FieldSpec,
  GenerateObjectOptions,
  GenerateTextOptions,
  RuntimeAdapter,
  StateOpts,
  StopWhen,
  Tool,
  ToolDescriptor,
  WorkflowRef,
} from "@airun/sdk";
import { RunContext, Suspended, WAIT_STEP_LABELS } from "./context.js";
import type { AgentDecision, AgentTurn } from "./ports.js";
import { errorMessage } from "./trace.js";

const MAX_AGENT_STEPS = 100;

export class WorkflowRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly ctx: RunContext) {}

  // --- durable-step core -----------------------------------------------------

  private async durable<T>(label: string, exec: () => Promise<T> | T): Promise<T> {
    const key = this.ctx.nextStepKey(label);
    const found = await this.ctx.deps.journal.getStep(this.ctx.runId, key);
    if (found.found) return found.result as T; // replay: served from journal, not traced
    const runId = this.ctx.runId;
    const startedAt = Date.now();
    await this.ctx.trace({ type: "step.started", runId, at: startedAt, stepKey: key, label });
    try {
      const result = await exec();
      await this.ctx.deps.journal.putStep(runId, key, result);
      const finishedAt = Date.now();
      await this.ctx.trace({
        type: "step.completed",
        runId,
        at: finishedAt,
        stepKey: key,
        label,
        durationMs: finishedAt - startedAt,
        result,
      });
      return result;
    } catch (err) {
      // A Suspended thrown from within a step is a wait, not a failure — the run
      // is suspended, so leave it for the run-level event.
      if (err instanceof Suspended) throw err;
      const finishedAt = Date.now();
      await this.ctx.trace({
        type: "step.failed",
        runId,
        at: finishedAt,
        stepKey: key,
        label,
        durationMs: finishedAt - startedAt,
        error: errorMessage(err),
      });
      throw err;
    }
  }

  stepRun<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    return this.durable(`step.run:${name}`, fn);
  }

  // --- tools -----------------------------------------------------------------

  callTool<TArgs, TResult>(def: ToolDescriptor<TArgs, TResult>, args: TArgs): Promise<TResult> {
    return this.durable(`tool:${def.id}`, () => this.execTool(def, args));
  }

  private async execTool<TArgs, TResult>(
    def: ToolDescriptor<TArgs, TResult>,
    args: TArgs,
  ): Promise<TResult> {
    if (def.kind === "fn") return def.handler(args);

    const headers: Record<string, string> = { ...def.headers };
    if (def.auth) {
      // Secret is resolved at call time and never inlined into source.
      const secret = await this.ctx.deps.secrets.resolve(def.auth.secret);
      if (secret === undefined) {
        throw new Error(`Secret "${def.auth.secret}" required by tool "${def.id}" is not available.`);
      }
      headers["Authorization"] = `Bearer ${secret}`;
    }

    const url = this.applyQuery(def.url, def.query);
    const body = def.body ? def.body(args) : undefined;
    const res = await this.ctx.deps.http.request({ method: def.method, url, headers, body });
    return res.body as TResult;
  }

  private applyQuery(url: string, query?: Record<string, string>): string {
    if (!query || Object.keys(query).length === 0) return url;
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
  }

  // --- ai --------------------------------------------------------------------

  async generate<T>(opts: GenerateTextOptions | GenerateObjectOptions<T>): Promise<T | string> {
    const hasSchema = "schema" in opts && opts.schema !== undefined;
    const raw = await this.durable<unknown>("ai.generate", () =>
      this.ctx.deps.model.generate({
        kind: hasSchema ? "object" : "text",
        model: opts.model,
        system: typeof opts.system === "string" ? opts.system : undefined,
        prompt: opts.prompt,
      }),
    );
    return hasSchema ? (opts as GenerateObjectOptions<T>).schema.parse(raw) : String(raw);
  }

  async classify<L extends string>(opts: {
    model: string;
    input: string;
    labels: readonly L[];
    instructions?: string;
  }): Promise<L> {
    const label = await this.durable<string>("ai.classify", () =>
      this.ctx.deps.model.classify(opts),
    );
    return label as L;
  }

  async agent<T>(opts: AgentOptions<T>): Promise<T | string> {
    const conditions = Array.isArray(opts.stopWhen) ? opts.stopWhen : [opts.stopWhen];
    const history: AgentTurn[] = [];
    let step = 0;
    let toolCalls = 0;
    let output: unknown = "";

    for (;;) {
      step++;
      const decision = await this.durable<AgentDecision>("ai.agent.decision", () =>
        this.ctx.deps.model.agentStep({
          model: opts.model,
          system: typeof opts.system === "string" ? opts.system : undefined,
          prompt: opts.prompt,
          tools: opts.tools.map((t) => ({ id: t.id })),
          history,
        }),
      );

      if (decision.kind === "tool") {
        toolCalls++;
        const tool = opts.tools.find((t) => t.id === decision.toolId);
        if (!tool) throw new Error(`Agent requested unknown tool "${decision.toolId}".`);
        // `AnyTool` has a `never` argument so it can hold tools of any shape; the
        // model supplies args dynamically, so we relax the call here.
        const result = await (tool as Tool)(decision.args);
        history.push({ toolId: decision.toolId, args: decision.args, result });
      } else {
        output = decision.output;
      }

      if (decision.kind === "final" || this.stopHit(conditions, { step, toolCalls }, decision)) break;
      if (step >= MAX_AGENT_STEPS) break;
    }

    return opts.schema ? opts.schema.parse(output) : String(output);
  }

  private stopHit(conditions: StopWhen[], info: AgentStepInfo, decision: AgentDecision): boolean {
    return conditions.some((c) => this.oneStop(c, info, decision));
  }

  private oneStop(condition: StopWhen, info: AgentStepInfo, decision: AgentDecision): boolean {
    switch (condition.kind) {
      case "maxSteps":
        return info.step >= condition.value;
      case "noToolUse":
        return decision.kind === "final";
      case "toolCalled":
        return decision.kind === "tool" && decision.toolId === condition.tool.id;
      case "condition":
        return condition.predicate(info);
      case "any":
        return condition.conditions.some((c) => this.oneStop(c, info, decision));
    }
  }

  // --- human-in-the-loop (suspension) ---------------------------------------

  async approval(opts: ApprovalOptions): Promise<ApprovalResult> {
    const key = this.ctx.nextStepKey(WAIT_STEP_LABELS.approval);
    const found = await this.ctx.deps.journal.getStep(this.ctx.runId, key);
    if (found.found) return found.result as ApprovalResult;
    this.ctx.waits.push({
      kind: "approval",
      stepKey: key,
      prompt: opts.prompt,
      assignee: opts.assignee,
      timeout: opts.timeout,
    });
    throw new Suspended(key);
  }

  async input<T extends Record<string, unknown>>(opts: {
    prompt: string;
    fields: { [K in keyof T]: FieldSpec<T[K]> };
    assignee?: string;
    timeout?: Duration;
  }): Promise<T> {
    const key = this.ctx.nextStepKey(WAIT_STEP_LABELS.input);
    const found = await this.ctx.deps.journal.getStep(this.ctx.runId, key);
    if (found.found) return found.result as T;
    this.ctx.waits.push({
      kind: "input",
      stepKey: key,
      prompt: opts.prompt,
      fields: opts.fields as Record<string, unknown>,
      assignee: opts.assignee,
      timeout: opts.timeout,
    });
    throw new Suspended(key);
  }

  invoke<TInput, TOutput>(_ref: WorkflowRef<TInput, TOutput>, _input: TInput): Promise<TOutput> {
    throw new Error("step.invoke (subworkflows) is not supported by the v1 runtime.");
  }

  // --- state -----------------------------------------------------------------

  private scopeKey(scope: StateOpts<unknown>["scope"]): string {
    switch (scope) {
      case "persistent":
        return "persistent:global";
      case "session":
        return `session:${this.ctx.runId}`;
      case "run":
        return `run:${this.ctx.runId}`;
    }
  }

  stateGet<T>(name: string, opts: StateOpts<T>): Promise<T> {
    return this.durable(`state.get:${name}`, async () => {
      const cur = await this.ctx.deps.journal.getState(this.scopeKey(opts.scope), name);
      return (cur.found ? cur.result : opts.initial) as T;
    });
  }

  async stateSet<T>(name: string, opts: StateOpts<T>, value: T): Promise<void> {
    await this.durable<null>(`state.set:${name}`, async () => {
      await this.ctx.deps.journal.putState(this.scopeKey(opts.scope), name, value);
      return null;
    });
  }

  async stateAppend<T>(name: string, opts: StateOpts<T>, item: unknown): Promise<void> {
    // Delegated so the journal can apply it atomically; the durable wrapper still
    // guarantees it fires once per run (replays skip it).
    await this.durable<null>(`state.append:${name}`, async () => {
      await this.ctx.deps.journal.appendState(this.scopeKey(opts.scope), name, item, opts.initial);
      return null;
    });
  }

  async stateMerge<T>(name: string, opts: StateOpts<T>, partial: unknown): Promise<void> {
    await this.durable<null>(`state.merge:${name}`, async () => {
      await this.ctx.deps.journal.mergeState(this.scopeKey(opts.scope), name, partial, opts.initial);
      return null;
    });
  }
}
