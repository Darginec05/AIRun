// Runtime validation for the WorkflowGraph IR.
//
// Two layers:
//   1. Structural — zod schemas mirroring the types in ./index. Catches shape errors.
//   2. Semantic   — the cross-cutting rules in WORKFLOW_INVARIANTS (single trigger,
//                   edge/port consistency, DAG-ness, dangling refs, etc.) that a
//                   per-field schema can't express.
//
// validateWorkflow() runs both and returns a flat issue list keyed by invariant id.

import { z } from "zod";
import type {
  Binding,
  DataType,
  PortDirection,
  PortKind,
  WorkflowGraph,
  WorkflowNode,
} from "./index.js";

// ---------------------------------------------------------------------------
// Structural schemas (zod)
// ---------------------------------------------------------------------------

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

const schemaId = z.string();

const dataType: z.ZodType<DataType> = z.union([
  z.literal("string"),
  z.literal("number"),
  z.literal("boolean"),
  z.literal("json"),
  z.literal("conversation"),
  z.literal("any"),
  z.object({ kind: z.literal("schema"), schema: schemaId }),
]);

const durationRe = /^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/;
const duration = z.string().regex(durationRe, "expected a duration like '30s' or '5m'");

const binding: z.ZodType<Binding> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("literal"), value: jsonValue }),
    z.object({ kind: z.literal("ref"), nodeId: z.string(), path: z.string().optional() }),
    z.object({ kind: z.literal("var"), name: z.string() }),
    z.object({ kind: z.literal("template"), segments: z.array(templateSegment) }),
  ]),
) as z.ZodType<Binding>;

const templateSegment: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("text"), value: z.string() }),
    z.object({ kind: z.literal("expr"), binding }),
  ]),
);

const compareOp = z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"]);

const condition: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("compare"), op: compareOp, left: binding, right: binding }),
    z.object({ kind: z.literal("and"), conditions: z.array(condition) }),
    z.object({ kind: z.literal("or"), conditions: z.array(condition) }),
    z.object({ kind: z.literal("not"), condition }),
    z.object({
      kind: z.literal("expr"),
      unsafe: z.literal(true),
      language: z.literal("js"),
      source: z.string(),
    }),
  ]),
);

const portKind = z.enum(["control", "data"]);
const portDirection = z.enum(["in", "out"]);

const port = z.object({
  id: z.string(),
  kind: portKind,
  direction: portDirection,
  name: z.string(),
  dataType: dataType.optional(),
});

const portRef = z.object({ nodeId: z.string(), portId: z.string() });

const edge = z.object({
  id: z.string(),
  kind: portKind,
  from: portRef,
  to: portRef,
});

const httpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const secretRef = z.object({ kind: z.literal("secret"), name: z.string() });

const backoff = z.object({
  strategy: z.enum(["fixed", "exponential"]),
  delay: duration,
  factor: z.number().optional(),
});

const errorFallback = z.union([
  z.object({ kind: z.literal("value"), value: binding }),
  z.object({ kind: z.literal("route") }),
]);

const errorPolicy = z.union([
  z.object({ kind: z.literal("throw") }),
  z.object({
    kind: z.literal("retry"),
    maxAttempts: z.number(),
    backoff: backoff.optional(),
    then: errorFallback.optional(),
  }),
  z.object({ kind: z.literal("fallback"), fallback: errorFallback }),
  z.object({ kind: z.literal("catch") }),
]);

const systemPrompt = z.union([
  z.object({ kind: z.literal("static"), text: z.string() }),
  z.object({ kind: z.literal("dynamic"), binding }),
  z.object({ kind: z.literal("composed"), segments: z.array(templateSegment) }),
]);

const llmOutput = z.union([
  z.object({ kind: z.literal("text") }),
  z.object({ kind: z.literal("structured"), schema: schemaId }),
]);

const stopCondition: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("maxSteps"), value: z.number() }),
    z.object({ kind: z.literal("noToolUse") }),
    z.object({ kind: z.literal("toolCalled"), toolId: z.string() }),
    z.object({ kind: z.literal("condition"), condition }),
    z.object({ kind: z.literal("any"), conditions: z.array(stopCondition) }),
  ]),
);

const aggregateStrategy = z.union([
  z.object({ kind: z.literal("merge") }),
  z.object({ kind: z.literal("object"), keys: z.array(z.string()) }),
  z.object({ kind: z.literal("vote"), tally: z.enum(["majority", "unanimous"]) }),
  z.object({
    kind: z.literal("reduce"),
    reducer: z.object({ module: z.string(), exportName: z.string() }),
  }),
  z.object({ kind: z.literal("first") }),
]);

const transformSpec = z.union([
  z.object({ kind: z.literal("fn"), module: z.string(), exportName: z.string() }),
  z.object({ kind: z.literal("pick"), paths: z.array(z.string()) }),
  z.object({ kind: z.literal("map"), mapping: z.record(binding) }),
  z.object({
    kind: z.literal("expr"),
    unsafe: z.literal(true),
    language: z.literal("js"),
    source: z.string(),
  }),
]);

const layout = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const baseFields = {
  id: z.string(),
  label: z.string().optional(),
  layout,
  ports: z.array(port),
};

const triggerNode = z.object({
  ...baseFields,
  type: z.literal("trigger"),
  config: z.object({
    trigger: z.union([
      z.object({ kind: z.literal("event"), eventName: z.string(), inputSchema: schemaId.optional() }),
      z.object({ kind: z.literal("schedule"), cron: z.string(), timezone: z.string().optional() }),
      z.object({
        kind: z.literal("webhook"),
        path: z.string(),
        method: httpMethod,
        inputSchema: schemaId.optional(),
      }),
    ]),
  }),
});

const llmNode = z.object({
  ...baseFields,
  type: z.literal("llm"),
  config: z.object({
    model: binding,
    systemPrompt: systemPrompt.optional(),
    prompt: binding,
    output: llmOutput.optional(),
    temperature: binding.optional(),
    maxTokens: binding.optional(),
    onError: errorPolicy.optional(),
  }),
});

const routerNode = z.object({
  ...baseFields,
  type: z.literal("router"),
  config: z.object({
    input: binding,
    mode: z.enum(["condition", "classify"]),
    model: binding.optional(),
    routes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        condition: condition.optional(),
        description: z.string().optional(),
      }),
    ),
    fallbackRouteId: z.string().optional(),
  }),
});

const toolNode = z.object({
  ...baseFields,
  type: z.literal("tool"),
  config: z.object({
    toolId: z.string(),
    args: z.record(binding),
    onError: errorPolicy.optional(),
  }),
});

const agentLoopNode = z.object({
  ...baseFields,
  type: z.literal("agentLoop"),
  config: z.object({
    model: binding,
    systemPrompt: systemPrompt.optional(),
    prompt: binding,
    toolIds: z.array(z.string()),
    stopCondition,
    output: llmOutput.optional(),
    onError: errorPolicy.optional(),
  }),
});

const parallelNode = z.object({
  ...baseFields,
  type: z.literal("parallel"),
  config: z.object({
    mode: z.enum(["branches", "map"]),
    over: binding.optional(),
    itemVar: z.string().optional(),
    maxConcurrency: z.number().optional(),
    aggregate: aggregateStrategy,
  }),
});

const conditionalNode = z.object({
  ...baseFields,
  type: z.literal("conditional"),
  config: z.object({
    branches: z.array(
      z.object({ id: z.string(), name: z.string().optional(), condition }),
    ),
    hasElse: z.boolean(),
  }),
});

const loopNode = z.object({
  ...baseFields,
  type: z.literal("loop"),
  config: z.object({
    mode: z.enum(["while", "forEach", "count"]),
    condition: condition.optional(),
    collection: binding.optional(),
    itemVar: z.string().optional(),
    count: binding.optional(),
    maxIterations: z.number().optional(),
  }),
});

const humanApprovalNode = z.object({
  ...baseFields,
  type: z.literal("humanApproval"),
  config: z.object({
    prompt: binding,
    assignee: binding.optional(),
    timeout: duration.optional(),
    onTimeout: z.enum(["approve", "reject", "escalate"]).optional(),
  }),
});

const humanInputNode = z.object({
  ...baseFields,
  type: z.literal("humanInput"),
  config: z.object({
    prompt: binding,
    fields: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        dataType,
        required: z.boolean().optional(),
        default: binding.optional(),
      }),
    ),
    assignee: binding.optional(),
    timeout: duration.optional(),
  }),
});

const stateNode = z.object({
  ...baseFields,
  type: z.literal("state"),
  config: z.object({
    variable: z.string(),
    operation: z.enum(["get", "set", "append", "merge"]),
    value: binding.optional(),
  }),
});

const transformNode = z.object({
  ...baseFields,
  type: z.literal("transform"),
  config: z.object({ input: binding, transform: transformSpec }),
});

const subworkflowNode = z.object({
  ...baseFields,
  type: z.literal("subworkflow"),
  config: z.object({
    workflowId: z.string(),
    version: z.string().optional(),
    inputs: z.record(binding),
  }),
});

const outputNode = z.object({
  ...baseFields,
  type: z.literal("output"),
  config: z.object({ value: binding, schema: schemaId.optional() }),
});

const workflowNode = z.discriminatedUnion("type", [
  triggerNode,
  llmNode,
  routerNode,
  toolNode,
  agentLoopNode,
  parallelNode,
  conditionalNode,
  loopNode,
  humanApprovalNode,
  humanInputNode,
  stateNode,
  transformNode,
  subworkflowNode,
  outputNode,
]);

const httpToolDef = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  inputSchema: schemaId.optional(),
  outputSchema: schemaId.optional(),
  impl: z.literal("http"),
  method: binding,
  url: binding,
  headers: z.record(binding).optional(),
  query: z.record(binding).optional(),
  body: binding.optional(),
  auth: secretRef.optional(),
});

const fnToolDef = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  inputSchema: schemaId.optional(),
  outputSchema: schemaId.optional(),
  impl: z.literal("fn"),
  module: z.string(),
  exportName: z.string(),
});

const toolDef = z.discriminatedUnion("impl", [httpToolDef, fnToolDef]);

const variableDef = z.object({
  name: z.string(),
  scope: z.enum(["run", "session", "persistent"]),
  dataType,
  initial: binding.optional(),
  description: z.string().optional(),
});

const secretDef = z.object({ name: z.string(), description: z.string().optional() });

const graphMetadata = z.object({
  description: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  authoredBy: z.string().optional(),
});

export const workflowGraphSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  schemaVersion: z.literal(1),
  nodes: z.array(workflowNode),
  edges: z.array(edge),
  variables: z.array(variableDef),
  tools: z.array(toolDef),
  schemas: z.record(z.record(jsonValue)),
  secrets: z.array(secretDef),
  metadata: graphMetadata,
});

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /** WORKFLOW_INVARIANTS id, or "structure" for a zod shape error. */
  invariant: string;
  message: string;
  path?: string;
}

export type ValidationResult =
  | { ok: true; graph: WorkflowGraph }
  | { ok: false; issues: ValidationIssue[] };

// ---------------------------------------------------------------------------
// Derived ports — computed from config, not authored in node.ports
// ---------------------------------------------------------------------------

interface PortInfo {
  kind: PortKind;
  direction: PortDirection;
  dataType?: DataType;
}

function hasErrorOut(node: WorkflowNode): boolean {
  const onError = (node.config as { onError?: unknown }).onError as
    | { kind: string; then?: { kind: string }; fallback?: { kind: string } }
    | undefined;
  if (!onError) return false;
  if (onError.kind === "catch") return true;
  if (onError.kind === "retry") return onError.then?.kind === "route";
  if (onError.kind === "fallback") return onError.fallback?.kind === "route";
  return false;
}

function portIndex(node: WorkflowNode): Map<string, PortInfo> {
  const m = new Map<string, PortInfo>();
  for (const p of node.ports) m.set(p.id, { kind: p.kind, direction: p.direction, dataType: p.dataType });

  const ctrlOut: PortInfo = { kind: "control", direction: "out" };
  const ctrlIn: PortInfo = { kind: "control", direction: "in" };

  switch (node.type) {
    case "router":
      for (const r of node.config.routes) m.set(`route:${r.id}`, ctrlOut);
      break;
    case "conditional":
      for (const b of node.config.branches) m.set(`branch:${b.id}`, ctrlOut);
      if (node.config.hasElse) m.set("branch:else", ctrlOut);
      break;
    case "humanApproval":
      m.set("approved", ctrlOut);
      m.set("rejected", ctrlOut);
      break;
    case "loop":
      m.set("body", ctrlOut);
      m.set("done", ctrlOut);
      m.set("continue", ctrlIn);
      break;
    case "parallel":
      m.set("branch", ctrlOut);
      m.set("join", ctrlIn);
      break;
    default:
      break;
  }
  if (hasErrorOut(node)) m.set("error", ctrlOut);
  return m;
}

// ---------------------------------------------------------------------------
// Generic deep-walk to collect bindings / schema / secret usages
// ---------------------------------------------------------------------------

function* walk(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const v of value) yield* walk(v);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    yield obj;
    for (const v of Object.values(obj)) yield* walk(v);
  }
}

function dataTypesCompatible(a?: DataType, b?: DataType): boolean {
  if (!a || !b) return true;
  if (a === "any" || b === "any") return true;
  if (typeof a === "object" && typeof b === "object") return a.schema === b.schema;
  return a === b;
}

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

function semanticIssues(graph: WorkflowGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (invariant: string, message: string, path?: string) =>
    issues.push({ invariant, message, path });

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeIds = new Set(nodeById.keys());
  const varNames = new Set(graph.variables.map((v) => v.name));
  const toolIds = new Set(graph.tools.map((t) => t.id));
  const schemaIds = new Set(Object.keys(graph.schemas));
  const secretNames = new Set(graph.secrets.map((s) => s.name));

  // single-trigger
  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) {
    add("single-trigger", `expected exactly one trigger node, found ${triggers.length}`);
  }

  // unique-ids
  const dupe = (label: string, ids: string[], invariant: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) add(invariant, `duplicate ${label} id: ${id}`);
      seen.add(id);
    }
  };
  dupe("node", graph.nodes.map((n) => n.id), "unique-ids");
  dupe("edge", graph.edges.map((e) => e.id), "unique-ids");
  dupe("variable", graph.variables.map((v) => v.name), "unique-ids");
  dupe("tool", graph.tools.map((t) => t.id), "unique-ids");

  // edges: endpoints exist, direction, kind match, data-type compat
  const portIndexCache = new Map<string, Map<string, PortInfo>>();
  const portsOf = (node: WorkflowNode) => {
    let idx = portIndexCache.get(node.id);
    if (!idx) {
      idx = portIndex(node);
      portIndexCache.set(node.id, idx);
    }
    return idx;
  };

  for (const e of graph.edges) {
    const fromNode = nodeById.get(e.from.nodeId);
    const toNode = nodeById.get(e.to.nodeId);
    if (!fromNode) {
      add("edge-endpoints-exist", `edge ${e.id}: from node '${e.from.nodeId}' does not exist`);
    }
    if (!toNode) {
      add("edge-endpoints-exist", `edge ${e.id}: to node '${e.to.nodeId}' does not exist`);
    }
    let fromPort: PortInfo | undefined;
    let toPort: PortInfo | undefined;
    if (fromNode) {
      fromPort = portsOf(fromNode).get(e.from.portId);
      if (!fromPort) {
        add("edge-endpoints-exist", `edge ${e.id}: port '${e.from.portId}' not found on '${e.from.nodeId}'`);
      } else {
        if (fromPort.direction !== "out") add("edge-direction", `edge ${e.id}: must leave an 'out' port`);
        if (fromPort.kind !== e.kind) add("edge-kind-match", `edge ${e.id}: kind '${e.kind}' != from-port kind '${fromPort.kind}'`);
      }
    }
    if (toNode) {
      toPort = portsOf(toNode).get(e.to.portId);
      if (!toPort) {
        add("edge-endpoints-exist", `edge ${e.id}: port '${e.to.portId}' not found on '${e.to.nodeId}'`);
      } else {
        if (toPort.direction !== "in") add("edge-direction", `edge ${e.id}: must enter an 'in' port`);
        if (toPort.kind !== e.kind) add("edge-kind-match", `edge ${e.id}: kind '${e.kind}' != to-port kind '${toPort.kind}'`);
      }
    }
    if (e.kind === "data" && fromPort && toPort && !dataTypesCompatible(fromPort.dataType, toPort.dataType)) {
      add("data-type-compat", `edge ${e.id}: incompatible data types`);
    }
  }

  // data flow is a DAG
  if (hasCycle(graph, "data", nodeIds)) {
    add("data-is-dag", "the data-flow subgraph contains a cycle");
  }
  // control cycles only through a loop's "continue" port
  if (hasControlCycleOutsideLoop(graph, nodeIds)) {
    add("control-cycles-only-via-loop", "control-flow cycle not routed through a loop's 'continue' port");
  }

  // refs / vars / schemas / secrets usages
  for (const obj of walk(graph.nodes)) {
    if (obj.kind === "ref" && typeof obj.nodeId === "string") {
      if (!nodeIds.has(obj.nodeId)) add("ref-targets-exist", `ref to missing node '${obj.nodeId}'`);
    }
    if (obj.kind === "var" && typeof obj.name === "string") {
      if (!varNames.has(obj.name)) add("var-declared", `binding references undeclared variable '${obj.name}'`);
    }
    if (obj.kind === "secret" && typeof obj.name === "string") {
      if (!secretNames.has(obj.name)) add("secret-refs-declared", `undeclared secret '${obj.name}'`);
    }
    for (const key of ["schema", "inputSchema", "outputSchema"]) {
      const v = obj[key];
      if (typeof v === "string" && !schemaIds.has(v)) {
        add("schema-ids-resolve", `unknown schema id '${v}'`);
      }
    }
  }
  // tool def bodies/headers may also reference secrets/schemas
  for (const obj of walk(graph.tools)) {
    if (obj.kind === "secret" && typeof obj.name === "string" && !secretNames.has(obj.name)) {
      add("secret-refs-declared", `undeclared secret '${obj.name}'`);
    }
    for (const key of ["inputSchema", "outputSchema"]) {
      const v = obj[key];
      if (typeof v === "string" && !schemaIds.has(v)) add("schema-ids-resolve", `unknown schema id '${v}'`);
    }
  }

  // node-specific semantics
  for (const node of graph.nodes) {
    switch (node.type) {
      case "state":
        if (!varNames.has(node.config.variable)) {
          add("var-declared", `state node '${node.id}' targets undeclared variable '${node.config.variable}'`);
        }
        if (node.config.operation !== "get" && node.config.value === undefined) {
          add("var-declared", `state node '${node.id}' operation '${node.config.operation}' requires a value`);
        }
        break;
      case "tool":
        if (!toolIds.has(node.config.toolId)) {
          add("tool-ids-resolve", `tool node '${node.id}' references unknown tool '${node.config.toolId}'`);
        }
        break;
      case "agentLoop":
        for (const tid of node.config.toolIds) {
          if (!toolIds.has(tid)) add("tool-ids-resolve", `agentLoop '${node.id}' references unknown tool '${tid}'`);
        }
        break;
      case "router":
        if (node.config.mode === "classify" && node.config.model === undefined) {
          add("classify-needs-model", `router '${node.id}' in classify mode requires a model`);
        }
        if (node.config.fallbackRouteId && !node.config.routes.some((r) => r.id === node.config.fallbackRouteId)) {
          add("unique-ids", `router '${node.id}' fallbackRouteId '${node.config.fallbackRouteId}' is not a route id`);
        }
        break;
      case "loop":
        if ((node.config.mode === "while" || node.config.mode === "count") && node.config.maxIterations === undefined && node.config.count === undefined) {
          add("loop-bounds", `loop '${node.id}' (${node.config.mode}) needs a bound (maxIterations or count)`);
        }
        break;
      default:
        break;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Cycle detection helpers
// ---------------------------------------------------------------------------

function buildAdjacency(
  graph: WorkflowGraph,
  predicate: (e: WorkflowGraph["edges"][number]) => boolean,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    if (!predicate(e)) continue;
    const list = adj.get(e.from.nodeId);
    if (list) list.push(e.to.nodeId);
  }
  return adj;
}

function detectCycle(adj: Map<string, string[]>, nodeIds: Set<string>): boolean {
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 in-stack, 2 done
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      if (!nodeIds.has(next)) continue;
      const s = state.get(next) ?? 0;
      if (s === 1) return true;
      if (s === 0 && visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of nodeIds) {
    if ((state.get(id) ?? 0) === 0 && visit(id)) return true;
  }
  return false;
}

function hasCycle(graph: WorkflowGraph, kind: PortKind, nodeIds: Set<string>): boolean {
  return detectCycle(buildAdjacency(graph, (e) => e.kind === kind), nodeIds);
}

function hasControlCycleOutsideLoop(graph: WorkflowGraph, nodeIds: Set<string>): boolean {
  const loopIds = new Set(graph.nodes.filter((n) => n.type === "loop").map((n) => n.id));
  // Legal back-edges return into a loop's "continue" port; exclude them, then any
  // remaining control cycle is illegal.
  const adj = buildAdjacency(
    graph,
    (e) => e.kind === "control" && !(loopIds.has(e.to.nodeId) && e.to.portId === "continue"),
  );
  return detectCycle(adj, nodeIds);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateWorkflow(input: unknown): ValidationResult {
  const parsed = workflowGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        invariant: "structure",
        message: i.message,
        path: i.path.join("."),
      })),
    };
  }
  const graph = parsed.data as unknown as WorkflowGraph;
  const issues = semanticIssues(graph);
  return issues.length === 0 ? { ok: true, graph } : { ok: false, issues };
}

/** Throws on the first batch of validation issues; returns the typed graph otherwise. */
export function assertValidWorkflow(input: unknown): WorkflowGraph {
  const result = validateWorkflow(input);
  if (!result.ok) {
    const detail = result.issues.map((i) => `  [${i.invariant}] ${i.message}${i.path ? ` (${i.path})` : ""}`).join("\n");
    throw new Error(`Invalid WorkflowGraph:\n${detail}`);
  }
  return result.graph;
}
