import { describe, expect, it } from "vitest";
import { ai, defineWorkflow, state, step, stop, tool, trigger } from "@airun/sdk";
import type { Schema } from "@airun/sdk";
import { createRuntime, envSecretResolver } from "../src/index.js";
import type { HttpClient, HttpRequest, ModelClient, RunResult } from "../src/index.js";

function completed<T>(result: RunResult<T>): T {
  if (result.status !== "completed") throw new Error(`expected completed, got ${result.status}`);
  return result.output;
}

const passthrough = <T>(): Schema<T> => ({ parse: (x) => x as T });

// --- basic completion -------------------------------------------------------

describe("runWorkflow", () => {
  it("runs a linear workflow to completion", async () => {
    const wf = defineWorkflow<{ n: number }, number>({
      id: "wf_linear",
      on: trigger.onEvent("go"),
      run: ({ event }) => Promise.resolve(event.n * 2),
    });

    const result = await createRuntime().run(wf, { n: 21 });
    expect(completed(result)).toBe(42);
  });

  it("throws when a primitive is used outside a run", () => {
    expect(() => step.run("x", () => 1)).toThrow(/No active/);
  });
});

// --- durability: replay serves completed steps from the journal -------------

describe("durable replay", () => {
  it("runs a side-effecting step exactly once across a suspend/resume", async () => {
    let sideEffects = 0;

    const wf = defineWorkflow<{ n: number }, number>({
      id: "wf_replay",
      on: trigger.onEvent("go"),
      run: async ({ event }) => {
        const doubled = await step.run("double", () => {
          sideEffects++;
          return event.n * 2;
        });
        const decision = await step.approval({ prompt: "ok?" });
        return decision.approved ? doubled : -1;
      },
    });

    const rt = createRuntime();
    const first = await rt.run(wf, { n: 5 });
    if (first.status !== "suspended") throw new Error("expected suspension on approval");
    expect(sideEffects).toBe(1);

    const wait = first.waits[0]!;
    expect(wait.kind).toBe("approval");

    const second = await rt.resume(wf, first.runId, wait.stepKey, { approved: true });
    expect(completed(second)).toBe(10);
    // The journaled step result is replayed, not recomputed.
    expect(sideEffects).toBe(1);
  });

  it("suspends on approval and resumes with the delivered decision", async () => {
    const wf = defineWorkflow<{ id: string }, string>({
      id: "wf_approval",
      on: trigger.onEvent("go"),
      run: async ({ event }) => {
        const decision = await step.approval({ prompt: `approve ${event.id}?`, timeout: "24h" });
        return decision.approved ? `approved:${decision.by ?? "?"}` : "rejected";
      },
    });

    const rt = createRuntime();
    const first = await rt.run(wf, { id: "inv_1" });
    if (first.status !== "suspended") throw new Error("expected suspension");
    expect(first.waits).toHaveLength(1);

    const second = await rt.resume(wf, first.runId, first.waits[0]!.stepKey, {
      approved: true,
      by: "alice",
    });
    expect(completed(second)).toBe("approved:alice");
  });

  it("refuses to deliver to a non-wait step key", async () => {
    const wf = defineWorkflow<{ x: number }, number>({
      id: "wf_guard",
      on: trigger.onEvent("go"),
      run: async ({ event }) => {
        await step.approval({ prompt: "?" });
        return event.x;
      },
    });

    const rt = createRuntime();
    const first = await rt.run(wf, { x: 1 });
    if (first.status !== "suspended") throw new Error("expected suspension");

    await expect(rt.resume(wf, first.runId, "tool:postLedger#1", {})).rejects.toThrow(
      /not an approval\/input wait key/,
    );
  });

  it("refuses to resume a run that is not suspended", async () => {
    const wf = defineWorkflow<{ x: number }, number>({
      id: "wf_done",
      on: trigger.onEvent("go"),
      run: ({ event }) => Promise.resolve(event.x),
    });

    const rt = createRuntime();
    const done = await rt.run(wf, { x: 7 });
    expect(done.status).toBe("completed");

    await expect(rt.resume(wf, done.runId, "step.approval#1", { approved: true })).rejects.toThrow(
      /not awaiting input/,
    );
  });
});

// --- tools: durable calls, secrets resolved at call time --------------------

describe("tools", () => {
  it("invokes an http tool with the secret resolved at call time", async () => {
    const calls: HttpRequest[] = [];
    const http: HttpClient = {
      request: (req) => {
        calls.push(req);
        return Promise.resolve({ status: 200, body: { entryId: "e1" } });
      },
    };

    const postLedger = tool.http<{ data: unknown }, { entryId: string }>({
      id: "postLedger",
      method: "POST",
      url: "https://ledger.internal/entries",
      auth: { secret: "LEDGER_KEY" },
      body: (args) => args.data,
    });

    const wf = defineWorkflow<{ amount: number }, { entryId: string }>({
      id: "wf_tool",
      on: trigger.onEvent("go"),
      run: ({ event }) => postLedger({ data: event }),
    });

    const rt = createRuntime({ http, secrets: envSecretResolver({ LEDGER_KEY: "sek_live_123" }) });
    const result = await rt.run(wf, { amount: 42 });

    expect(completed(result)).toEqual({ entryId: "e1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers?.["Authorization"]).toBe("Bearer sek_live_123");
    expect(calls[0]!.body).toEqual({ amount: 42 });
  });
});

// --- state: persistent scope survives across runs ---------------------------

describe("state", () => {
  it("accumulates persistent state across separate runs on the same journal", async () => {
    const seen = state<string[]>("seen", { scope: "persistent", initial: [] });

    const wf = defineWorkflow<{ id: string }, number>({
      id: "wf_state",
      on: trigger.onEvent("go"),
      run: async ({ event }) => {
        await seen.append(event.id);
        return (await seen.get()).length;
      },
    });

    const rt = createRuntime();
    expect(completed(await rt.run(wf, { id: "a" }))).toBe(1);
    expect(completed(await rt.run(wf, { id: "b" }))).toBe(2);
  });
});

// --- agent loop: durable tool calls until stopWhen --------------------------

describe("agent loop", () => {
  it("drives tools until the model finalizes", async () => {
    const model: ModelClient = {
      generate: () => Promise.resolve({}),
      classify: () => Promise.resolve("x"),
      agentStep: (req) =>
        Promise.resolve(
          req.history.length < 2
            ? { kind: "tool", toolId: "echo", args: { i: req.history.length } }
            : { kind: "final", output: { turns: req.history.length } },
        ),
    };

    const echo = tool.fn({
      id: "echo",
      handler: (args: unknown) => args,
    });

    const wf = defineWorkflow<Record<string, never>, { turns: number }>({
      id: "wf_agent",
      on: trigger.onEvent("go"),
      run: () =>
        ai.agent({
          model: "m",
          prompt: "go",
          tools: [echo],
          stopWhen: stop.maxSteps(10),
          schema: passthrough<{ turns: number }>(),
        }),
    });

    const result = await createRuntime({ model }).run(wf, {});
    expect(completed(result)).toEqual({ turns: 2 });
  });
});
