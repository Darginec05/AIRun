import { describe, expect, it } from "vitest";
import { defineWorkflow, trigger } from "@airun/sdk";
import { anthropicModelClient, createRuntime, postgresJournal } from "../src/index.js";
import type { Queryable } from "../src/index.js";

// --- Postgres journal -------------------------------------------------------

// A faithful in-memory stand-in for Postgres: it stores parsed jsonb (as the
// real driver returns it) and recognizes the handful of statements the journal
// issues. It exercises the envelope/found semantics without a live database.
class FakePg implements Queryable {
  readonly runs = new Map<string, { status: string; input: unknown; output: unknown }>();
  readonly steps = new Map<string, unknown>();
  readonly state = new Map<string, unknown>();
  readonly events: { runId: string; event: unknown }[] = [];

  query<R>(text: string, params: readonly unknown[] = []): Promise<{ rows: R[] }> {
    const sql = text.trim();
    const json = (i: number): unknown => JSON.parse(params[i] as string);
    const rows = (r: unknown[]): { rows: R[] } => ({ rows: r as R[] });
    const pairKey = (): string => `${params[0] as string} ${params[1] as string}`;

    if (sql.startsWith("CREATE TABLE")) return Promise.resolve(rows([]));

    if (sql.startsWith("INSERT INTO airun_runs")) {
      const [runId] = params as [string];
      if (!this.runs.has(runId)) {
        this.runs.set(runId, { status: "running", input: json(1), output: null });
      }
      return Promise.resolve(rows([]));
    }
    if (sql.startsWith("SELECT status, input, output FROM airun_runs")) {
      const rec = this.runs.get(params[0] as string);
      return Promise.resolve(rows(rec ? [rec] : []));
    }
    if (sql.startsWith("UPDATE airun_runs")) {
      const rec = this.runs.get(params[0] as string);
      if (rec) {
        rec.status = params[1] as string;
        if (sql.includes("output =")) rec.output = json(2);
      }
      return Promise.resolve(rows([]));
    }

    if (sql.startsWith("INSERT INTO airun_steps")) {
      this.steps.set(pairKey(), json(2));
      return Promise.resolve(rows([]));
    }
    if (sql.startsWith("SELECT result FROM airun_steps")) {
      const key = pairKey();
      return Promise.resolve(rows(this.steps.has(key) ? [{ result: this.steps.get(key) }] : []));
    }

    if (sql.startsWith("INSERT INTO airun_state")) {
      const key = pairKey();
      const exists = this.state.has(key);
      if (sql.includes("'array'")) {
        // appendState: seed with {v:$3} when absent, else concat $4 onto value.v.
        if (!exists) this.state.set(key, { v: json(2) });
        else {
          const cur = (this.state.get(key) as { v: unknown }).v;
          const arr = Array.isArray(cur) ? cur : [];
          this.state.set(key, { v: [...arr, ...(json(3) as unknown[])] });
        }
      } else if (sql.includes("'object'")) {
        // mergeState: seed with {v:$3} when absent, else merge $4 into value.v.
        if (!exists) this.state.set(key, { v: json(2) });
        else {
          const cur = (this.state.get(key) as { v: unknown }).v;
          const obj = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
          this.state.set(key, { v: { ...obj, ...(json(3) as Record<string, unknown>) } });
        }
      } else {
        this.state.set(key, json(2)); // putState: store the {v:…} envelope verbatim.
      }
      return Promise.resolve(rows([]));
    }
    if (sql.startsWith("SELECT value FROM airun_state")) {
      const key = pairKey();
      return Promise.resolve(rows(this.state.has(key) ? [{ value: this.state.get(key) }] : []));
    }

    if (sql.startsWith("INSERT INTO airun_events")) {
      this.events.push({ runId: params[0] as string, event: json(1) });
      return Promise.resolve(rows([]));
    }
    if (sql.startsWith("SELECT event FROM airun_events")) {
      const runId = params[0] as string;
      return Promise.resolve(rows(this.events.filter((e) => e.runId === runId).map((e) => ({ event: e.event }))));
    }

    throw new Error(`FakePg: unrecognized statement: ${sql}`);
  }
}

describe("PostgresJournal", () => {
  it("runs a side-effecting step exactly once across a suspend/resume", async () => {
    let sideEffects = 0;

    const wf = defineWorkflow<{ n: number }, number>({
      id: "wf_pg_replay",
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

    const journal = postgresJournal(new FakePg());
    await journal.ensureSchema();
    const rt = createRuntime({ journal });

    const first = await rt.run(wf, { n: 5 });
    if (first.status !== "suspended") throw new Error("expected suspension on approval");
    expect(sideEffects).toBe(1);

    const second = await rt.resume(wf, first.runId, first.waits[0]!.stepKey, { approved: true });
    if (second.status !== "completed") throw new Error("expected completion");
    expect(second.output).toBe(10);
    // The journaled step is replayed from Postgres, not recomputed.
    expect(sideEffects).toBe(1);
  });

  it("distinguishes a stored undefined from an absent step", async () => {
    const fake = new FakePg();
    const journal = postgresJournal(fake);
    await journal.ensureSchema();

    expect(await journal.getStep("r1", "k")).toEqual({ found: false, result: undefined });
    await journal.putStep("r1", "k", undefined);
    expect(await journal.getStep("r1", "k")).toEqual({ found: true, result: undefined });
  });

  it("accumulates persistent state across separate runs", async () => {
    const journal = postgresJournal(new FakePg());
    await journal.ensureSchema();
    const rt = createRuntime({ journal });

    const wf = defineWorkflow<{ id: string }, number>({
      id: "wf_pg_state",
      on: trigger.onEvent("go"),
      run: async ({ event, state }) => {
        const seen = state<string[]>("seen", { scope: "persistent", initial: [] });
        await seen.append(event.id);
        return (await seen.get()).length;
      },
    });

    const a = await rt.run(wf, { id: "a" });
    const b = await rt.run(wf, { id: "b" });
    if (a.status !== "completed" || b.status !== "completed") throw new Error("expected completion");
    expect(a.output).toBe(1);
    expect(b.output).toBe(2);
  });

  it("appends atomically: a concurrent read-modify-write would lose updates, the upsert does not", async () => {
    const journal = postgresJournal(new FakePg());
    await journal.ensureSchema();

    // Both calls start from the same empty state and race to append.
    await Promise.all([
      journal.appendState("persistent:global", "log", "a", []),
      journal.appendState("persistent:global", "log", "b", []),
    ]);

    const { result } = await journal.getState("persistent:global", "log");
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("merges into the stored object atomically", async () => {
    const journal = postgresJournal(new FakePg());
    await journal.ensureSchema();

    await journal.mergeState("run:r", "acc", { a: 1 }, {});
    await journal.mergeState("run:r", "acc", { b: 2 }, {});

    const { result } = await journal.getState("run:r", "acc");
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

// --- Anthropic model client -------------------------------------------------

type FetchArgs = { url: string; init: RequestInit };

function stubFetch(responder: (body: unknown) => unknown): {
  fetchImpl: typeof fetch;
  calls: FetchArgs[];
} {
  const calls: FetchArgs[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body as string);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(responder(body)),
      text: () => Promise.resolve(""),
    } as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("anthropicModelClient", () => {
  it("returns text for a text generation and sends auth headers", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      content: [{ type: "text", text: "hello world" }],
      stop_reason: "end_turn",
    }));
    const model = anthropicModelClient({ apiKey: "sk-test", fetchImpl });

    const out = await model.generate({ kind: "text", model: "claude-x", prompt: "hi" });
    expect(out).toBe("hello world");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
  });

  it("parses fenced JSON for object generation", async () => {
    const { fetchImpl } = stubFetch(() => ({
      content: [{ type: "text", text: '```json\n{"entryId":"e1"}\n```' }],
      stop_reason: "end_turn",
    }));
    const model = anthropicModelClient({ apiKey: "k", fetchImpl });

    const out = await model.generate({ kind: "object", model: "m", prompt: "make json" });
    expect(out).toEqual({ entryId: "e1" });
  });

  it("maps a tool_use response to a tool decision", async () => {
    const { fetchImpl } = stubFetch(() => ({
      content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { i: 1 } }],
      stop_reason: "tool_use",
    }));
    const model = anthropicModelClient({ apiKey: "k", fetchImpl });

    const decision = await model.agentStep({
      model: "m",
      prompt: "go",
      tools: [{ id: "echo" }],
      history: [],
    });
    expect(decision).toEqual({ kind: "tool", toolId: "echo", args: { i: 1 } });
  });

  it("constrains classify output to one of the labels", async () => {
    const { fetchImpl } = stubFetch(() => ({
      content: [{ type: "text", text: "The answer is REFUND." }],
      stop_reason: "end_turn",
    }));
    const model = anthropicModelClient({ apiKey: "k", fetchImpl });

    const label = await model.classify({
      model: "m",
      input: "give me my money back",
      labels: ["refund", "question"] as const,
    });
    expect(label).toBe("refund");
  });

  it("throws with the API status on a non-ok response", async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("rate limited"),
      } as Response)) as unknown as typeof fetch;
    const model = anthropicModelClient({ apiKey: "k", fetchImpl });

    await expect(model.generate({ kind: "text", model: "m", prompt: "x" })).rejects.toThrow(/429/);
  });
});
