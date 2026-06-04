import { describe, expect, it } from "vitest";
import { defineWorkflow, trigger } from "@airun/sdk";
import { createRuntime } from "../src/index.js";
import type { TraceEvent } from "../src/index.js";

describe("traces", () => {
  it("assembles a timeline and traces each real step exactly once across suspend/resume", async () => {
    let sideEffects = 0;
    const wf = defineWorkflow<{ n: number }, number>({
      id: "wf_trace",
      on: trigger.onEvent("go"),
      run: async ({ event, step }) => {
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
    if (first.status !== "suspended") throw new Error("expected suspension");
    await rt.resume(wf, first.runId, first.waits[0]!.stepKey, { approved: true });

    const trace = await rt.trace(first.runId);
    expect(trace.status).toBe("completed");
    expect(trace.output).toBe(10);
    expect(trace.startedAt).toBeTypeOf("number");
    expect(trace.finishedAt).toBeTypeOf("number");

    // The replayed step is served from the journal, so it appears once, not twice.
    expect(sideEffects).toBe(1);
    expect(trace.steps).toHaveLength(1);
    const stepTrace = trace.steps[0]!;
    expect(stepTrace.label).toBe("step.run:double");
    expect(stepTrace.status).toBe("completed");
    expect(stepTrace.result).toBe(10);
    expect(stepTrace.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a failed step and a failed run status", async () => {
    const wf = defineWorkflow<Record<string, never>, number>({
      id: "wf_trace_fail",
      on: trigger.onEvent("go"),
      run: ({ step }) =>
        step.run("boom", () => {
          throw new Error("kaboom");
        }),
    });

    const rt = createRuntime();
    await expect(rt.run(wf, {}, { runId: "r_fail" })).rejects.toThrow(/kaboom/);

    const trace = await rt.trace("r_fail");
    expect(trace.status).toBe("failed");
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]!.status).toBe("failed");
    expect(trace.steps[0]!.error).toMatch(/kaboom/);
  });

  it("streams events live to the onTrace sink in execution order", async () => {
    const seen: TraceEvent[] = [];
    const wf = defineWorkflow<{ n: number }, number>({
      id: "wf_trace_live",
      on: trigger.onEvent("go"),
      run: ({ event, step }) => step.run("triple", () => event.n * 3),
    });

    const rt = createRuntime({ onTrace: (e) => seen.push(e) });
    await rt.run(wf, { n: 4 });

    const types = seen.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("run.completed");
    expect(types.indexOf("step.started")).toBeLessThan(types.indexOf("step.completed"));
  });

  it("throws when tracing an unknown run", async () => {
    const rt = createRuntime();
    await expect(rt.trace("nope")).rejects.toThrow(/Unknown run/);
  });
});
