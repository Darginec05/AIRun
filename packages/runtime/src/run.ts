// Run orchestration: start a workflow, and resume one that suspended on a
// human-in-the-loop wait. A resume re-runs the workflow from the top; completed
// steps are served from the journal so only the code past the now-resolved wait
// actually executes.

import { randomUUID } from "node:crypto";
import { ai, getWorkflowDef, installRuntimeResolver, state, step } from "@airun/sdk";
import type { WorkflowRef } from "@airun/sdk";
import { WorkflowRuntimeAdapter } from "./adapter.js";
import { activeAdapter, isWaitStepKey, RunContext, runWithin, Suspended } from "./context.js";
import type { PendingWait, RunDeps } from "./context.js";
import { InMemoryJournal } from "./journal.js";
import { envSecretResolver, fetchHttpClient, stubModelClient } from "./ports.js";

// Wire the SDK's primitives to the adapter active for the current async context.
installRuntimeResolver(() => activeAdapter());

export type RunResult<TOutput> =
  | { status: "completed"; runId: string; output: TOutput }
  | { status: "suspended"; runId: string; waits: PendingWait[] };

export interface Runtime {
  run<TPayload, TOutput>(
    ref: WorkflowRef<TPayload, TOutput>,
    input: TPayload,
    opts?: { runId?: string },
  ): Promise<RunResult<TOutput>>;
  resume<TPayload, TOutput>(
    ref: WorkflowRef<TPayload, TOutput>,
    runId: string,
    stepKey: string,
    result: unknown,
  ): Promise<RunResult<TOutput>>;
}

function withDefaults(overrides?: Partial<RunDeps>): RunDeps {
  return {
    journal: overrides?.journal ?? new InMemoryJournal(),
    model: overrides?.model ?? stubModelClient,
    http: overrides?.http ?? fetchHttpClient,
    secrets: overrides?.secrets ?? envSecretResolver(),
  };
}

async function attempt<TPayload, TOutput>(
  ref: WorkflowRef<TPayload, TOutput>,
  input: TPayload,
  runId: string,
  deps: RunDeps,
): Promise<RunResult<TOutput>> {
  const def = getWorkflowDef(ref);
  if (!def) {
    throw new Error("Workflow is not registered. It must be created with defineWorkflow().");
  }
  const ctx = new RunContext(runId, deps);
  const adapter = new WorkflowRuntimeAdapter(ctx);
  try {
    const output = await runWithin(adapter, () => def.run({ event: input, ai, step, state }));
    await deps.journal.setRunStatus(runId, "completed", output);
    return { status: "completed", runId, output };
  } catch (err) {
    if (err instanceof Suspended) {
      await deps.journal.setRunStatus(runId, "suspended");
      return { status: "suspended", runId, waits: ctx.waits };
    }
    await deps.journal.setRunStatus(runId, "failed");
    throw err;
  }
}

/**
 * A runtime instance owns one set of dependencies (notably its journal), so a
 * run and its later resume share durable state. Pass overrides to inject a real
 * model client, a Postgres journal, secrets, etc.
 */
export function createRuntime(overrides?: Partial<RunDeps>): Runtime {
  const deps = withDefaults(overrides);
  return {
    run: async (ref, input, opts) => {
      const runId = opts?.runId ?? randomUUID();
      await deps.journal.createRun(runId, input);
      return attempt(ref, input, runId, deps);
    },
    resume: async <TPayload, TOutput>(
      ref: WorkflowRef<TPayload, TOutput>,
      runId: string,
      stepKey: string,
      result: unknown,
    ) => {
      const record = await deps.journal.getRun(runId);
      if (!record) throw new Error(`Unknown run "${runId}".`);
      if (record.status !== "suspended") {
        throw new Error(`Run "${runId}" is "${record.status}", not awaiting input; nothing to resume.`);
      }
      // Only wait keys may be delivered — never overwrite a computed step's result.
      if (!isWaitStepKey(stepKey)) {
        throw new Error(`Cannot resume run "${runId}": "${stepKey}" is not an approval/input wait key.`);
      }
      await deps.journal.putStep(runId, stepKey, result);
      await deps.journal.setRunStatus(runId, "running");
      return attempt(ref, record.input as TPayload, runId, deps);
    },
  };
}
