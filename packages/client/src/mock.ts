// A browser-side RunClient that fabricates a plausible live trace from a graph,
// so the live-run overlay is demoable without a runtime server (the runtime is
// Node-only) or any secrets. It walks the graph in control-flow order from the
// trigger, emitting a started/completed pair per node with a small delay between
// them to simulate streaming. Crucially each step's `stepKey` is the node id, so
// the canvas overlay maps steps straight back to nodes. Results are simulated.

import type { WorkflowGraph, WorkflowNode } from "@airun/schema";
import type { RunClient, RunHandle } from "./client.js";
import type { TraceEvent } from "./trace.js";

export interface MockRunOptions {
  /** How long each simulated step "runs" before completing, ms. */
  stepMs?: number;
}

// Control-flow order from the trigger (BFS over control edges), with any nodes
// not reachable that way appended in declaration order so nothing is dropped.
function runOrder(graph: WorkflowGraph): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const controlOut = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== "control") continue;
    const list = controlOut.get(e.from.nodeId) ?? [];
    list.push(e.to.nodeId);
    controlOut.set(e.from.nodeId, list);
  }

  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const queue: string[] = trigger ? [trigger.id] : [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const next of controlOut.get(id) ?? []) if (!seen.has(next)) queue.push(next);
  }
  for (const node of graph.nodes) if (!seen.has(node.id)) ordered.push(node);
  return ordered;
}

function simulatedResult(node: WorkflowNode): unknown {
  switch (node.type) {
    case "llm":
      return { text: "…simulated model output…" };
    case "router":
      return { route: "default" };
    case "conditional":
      return { matched: true };
    case "output":
      return { ok: true };
    default:
      return { simulated: true, node: node.id };
  }
}

export function createMockRunClient(options: MockRunOptions = {}): RunClient {
  const stepMs = options.stepMs ?? 600;
  const gapMs = 140;

  return {
    startRun(graph, input, onEvent): RunHandle {
      const runId = `run_${Date.now().toString(36)}`;
      const order = runOrder(graph).filter((n) => n.type !== "trigger");
      const timers: ReturnType<typeof setTimeout>[] = [];
      let cancelled = false;
      const now = (): number => Date.now();
      const schedule = (fn: () => void, ms: number): void => {
        timers.push(setTimeout(fn, ms));
      };

      onEvent({ type: "run.started", runId, at: now(), input });

      let i = 0;
      const runStep = (): void => {
        if (cancelled) return;
        if (i >= order.length) {
          const last = order[order.length - 1];
          onEvent({ type: "run.completed", runId, at: now(), output: last ? simulatedResult(last) : { ok: true } });
          return;
        }
        const node = order[i++]!;
        const label = node.label ?? node.type;
        const startedAt = now();
        onEvent({ type: "step.started", runId, at: startedAt, stepKey: node.id, label });
        schedule(() => {
          if (cancelled) return;
          onEvent({
            type: "step.completed",
            runId,
            at: now(),
            stepKey: node.id,
            label,
            durationMs: now() - startedAt,
            result: simulatedResult(node),
          });
          schedule(runStep, gapMs);
        }, stepMs);
      };
      schedule(runStep, gapMs);

      return {
        runId,
        cancel(): void {
          cancelled = true;
          for (const t of timers) clearTimeout(t);
          timers.length = 0;
        },
      };
    },
  };
}
