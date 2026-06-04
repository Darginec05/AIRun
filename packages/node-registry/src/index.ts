// @airun/node-registry — the canonical list of node types.
//
// Each entry carries category, friendly name + technical type, port geometry,
// icon, default config. This is the single place every surface reads node-type
// metadata from: the palette groups by it, the canvas renders cards from it, and
// `derivePorts` computes the dynamic ports (router routes, conditional branches,
// approval outcomes, human-input fields, error routes) that the IR leaves
// implicit. Framework-agnostic plain data — no React, no codegen.

import type {
  AgentLoopNode,
  Bound,
  ConditionalNode,
  ErrorPolicy,
  HumanApprovalNode,
  HumanInputNode,
  JSONValue,
  LLMNode,
  LoopNode,
  NodeLayout,
  NodeType,
  OutputNode,
  ParallelNode,
  Port,
  RouterNode,
  StateNode,
  SubworkflowNode,
  ToolNode,
  TransformNode,
  TriggerNode,
  WorkflowNode,
} from "@airun/schema";

// ---------------------------------------------------------------------------
// Categories — each maps to one muted hue token in the design system.
// ---------------------------------------------------------------------------

export const CATEGORIES = {
  trigger: { label: "Triggers", hueVar: "--cat-trigger" },
  ai: { label: "AI", hueVar: "--cat-ai" },
  tools: { label: "Tools & Data", hueVar: "--cat-tools" },
  logic: { label: "Logic", hueVar: "--cat-logic" },
  human: { label: "Human", hueVar: "--cat-human" },
  memory: { label: "Memory & I/O", hueVar: "--cat-memory" },
} as const;

export type CategoryId = keyof typeof CATEGORIES;

/** The order categories appear in the palette. */
export const CATEGORY_ORDER = ["trigger", "ai", "tools", "logic", "human", "memory"] as const;

// ---------------------------------------------------------------------------
// Icons — semantic keys; the rendering surface maps each to an SVG. Plain
// strings keep this package free of any UI framework.
// ---------------------------------------------------------------------------

export const ICON_KEYS = [
  "zap",
  "sparkles",
  "repeat",
  "git-branch",
  "split",
  "rotate",
  "layers",
  "wrench",
  "shuffle",
  "package",
  "user-check",
  "clipboard",
  "database",
  "flag",
] as const;

export type IconKey = (typeof ICON_KEYS)[number];

// ---------------------------------------------------------------------------
// Node definitions
// ---------------------------------------------------------------------------

export interface NodeDefinition<N extends WorkflowNode = WorkflowNode> {
  type: N["type"];
  category: CategoryId;
  /** Friendly, non-coder-facing name. */
  name: string;
  /** Technical subtitle shown in mono — the SDK primitive underneath. */
  technical: string;
  icon: IconKey;
  summary: string;
  /** Static ports present on every instance; dynamic ports come from derivePorts. */
  staticPorts: Port[];
  defaultConfig: N["config"];
}

const lit = <T extends JSONValue>(value: T): Bound<T> => ({ kind: "literal", value });

const cIn = (id = "in", name = "in"): Port => ({ id, kind: "control", direction: "in", name });
const cOut = (id = "out", name = "out"): Port => ({ id, kind: "control", direction: "out", name });
const dOut = (id: string, name: string, dataType: Port["dataType"]): Port => ({
  id,
  kind: "data",
  direction: "out",
  name,
  dataType,
});
const dIn = (id: string, name: string, dataType: Port["dataType"]): Port => ({
  id,
  kind: "data",
  direction: "in",
  name,
  dataType,
});

type Registry = { [K in NodeType]: NodeDefinition<Extract<WorkflowNode, { type: K }>> };

export const NODE_TYPES = {
  trigger: {
    type: "trigger",
    category: "trigger",
    name: "Trigger",
    technical: "trigger",
    icon: "zap",
    summary: "Starts the workflow on an event, schedule, or webhook.",
    staticPorts: [cOut(), dOut("payload", "payload", "any")],
    defaultConfig: { trigger: { kind: "event", eventName: "event" } },
  } satisfies NodeDefinition<TriggerNode>,

  llm: {
    type: "llm",
    category: "ai",
    name: "Ask the AI",
    technical: "llm",
    icon: "sparkles",
    summary: "A single model call: prompt in, text or structured output out.",
    staticPorts: [cIn(), cOut(), dOut("result", "result", "any")],
    defaultConfig: { model: lit("claude-sonnet-4-6"), prompt: lit("") },
  } satisfies NodeDefinition<LLMNode>,

  agentLoop: {
    type: "agentLoop",
    category: "ai",
    name: "AI Agent",
    technical: "agentLoop",
    icon: "repeat",
    summary: "A tool-using model loop that runs until a stop condition is met.",
    staticPorts: [cIn(), cOut(), dOut("result", "result", "any")],
    defaultConfig: {
      model: lit("claude-sonnet-4-6"),
      prompt: lit(""),
      toolIds: [],
      stopCondition: { kind: "maxSteps", value: 8 },
    },
  } satisfies NodeDefinition<AgentLoopNode>,

  tool: {
    type: "tool",
    category: "tools",
    name: "Call a Tool",
    technical: "tool",
    icon: "wrench",
    summary: "Invokes a defined tool (HTTP call or owned function).",
    staticPorts: [cIn(), cOut(), dOut("result", "result", "any")],
    defaultConfig: { toolId: "", args: {} },
  } satisfies NodeDefinition<ToolNode>,

  transform: {
    type: "transform",
    category: "tools",
    name: "Transform",
    technical: "transform",
    icon: "shuffle",
    summary: "Reshape a value: pick fields, map keys, or run a function.",
    staticPorts: [cIn(), cOut(), dOut("result", "result", "any")],
    defaultConfig: { input: lit(null), transform: { kind: "pick", paths: [] } },
  } satisfies NodeDefinition<TransformNode>,

  subworkflow: {
    type: "subworkflow",
    category: "tools",
    name: "Subworkflow",
    technical: "subworkflow",
    icon: "package",
    summary: "Runs another workflow as a step and returns its output.",
    staticPorts: [cIn(), cOut(), dOut("result", "result", "any")],
    defaultConfig: { workflowId: "", inputs: {} },
  } satisfies NodeDefinition<SubworkflowNode>,

  router: {
    type: "router",
    category: "logic",
    name: "Router",
    technical: "router",
    icon: "git-branch",
    summary: "Sends control down one route by condition or classification.",
    staticPorts: [cIn()],
    defaultConfig: { input: lit(""), mode: "condition", routes: [] },
  } satisfies NodeDefinition<RouterNode>,

  conditional: {
    type: "conditional",
    category: "logic",
    name: "If / Else",
    technical: "conditional",
    icon: "split",
    summary: "Branches control on one or more predicates.",
    staticPorts: [cIn()],
    defaultConfig: { branches: [], hasElse: false },
  } satisfies NodeDefinition<ConditionalNode>,

  loop: {
    type: "loop",
    category: "logic",
    name: "Loop",
    technical: "loop",
    icon: "rotate",
    summary: "Repeats its body while/over a collection, then exits.",
    staticPorts: [cIn(), cOut("body", "body"), cIn("continue", "continue"), cOut("done", "done")],
    defaultConfig: { mode: "while", maxIterations: 100 },
  } satisfies NodeDefinition<LoopNode>,

  parallel: {
    type: "parallel",
    category: "logic",
    name: "Parallel",
    technical: "parallel",
    icon: "layers",
    summary: "Runs branches concurrently and aggregates their results.",
    staticPorts: [cIn(), cIn("join", "join"), cOut()],
    defaultConfig: { mode: "branches", aggregate: { kind: "merge" } },
  } satisfies NodeDefinition<ParallelNode>,

  humanApproval: {
    type: "humanApproval",
    category: "human",
    name: "Approval",
    technical: "humanApproval",
    icon: "user-check",
    summary: "Pauses for a human to approve or reject before continuing.",
    staticPorts: [cIn()],
    defaultConfig: { prompt: lit("Approve?") },
  } satisfies NodeDefinition<HumanApprovalNode>,

  humanInput: {
    type: "humanInput",
    category: "human",
    name: "Human Input",
    technical: "humanInput",
    icon: "clipboard",
    summary: "Pauses to collect typed fields from a person.",
    staticPorts: [cIn(), cOut()],
    defaultConfig: { prompt: lit("Provide input"), fields: [] },
  } satisfies NodeDefinition<HumanInputNode>,

  state: {
    type: "state",
    category: "memory",
    name: "State",
    technical: "state",
    icon: "database",
    summary: "Reads or writes a workflow variable (get/set/append/merge).",
    staticPorts: [cIn(), cOut(), dOut("value", "value", "any")],
    defaultConfig: { variable: "", operation: "get" },
  } satisfies NodeDefinition<StateNode>,

  output: {
    type: "output",
    category: "memory",
    name: "Output",
    technical: "output",
    icon: "flag",
    summary: "Terminal result of the workflow.",
    staticPorts: [cIn(), dIn("value", "value", "any")],
    defaultConfig: { value: lit(null) },
  } satisfies NodeDefinition<OutputNode>,
} satisfies Registry;

/** Palette layout: categories in display order, each with its node types. */
export const PALETTE_GROUPS: readonly { category: CategoryId; types: NodeType[] }[] = CATEGORY_ORDER.map(
  (category) => ({
    category,
    types: (Object.keys(NODE_TYPES) as NodeType[]).filter((t) => NODE_TYPES[t].category === category),
  }),
);

// ---------------------------------------------------------------------------
// Derived ports — dynamic ports the IR leaves implicit in config.
// ---------------------------------------------------------------------------

/** True when an error policy routes failures to a derived "error" control out-port. */
function routesError(onError: ErrorPolicy | undefined): boolean {
  if (!onError) return false;
  if (onError.kind === "catch") return true;
  if (onError.kind === "fallback") return onError.fallback.kind === "route";
  if (onError.kind === "retry") return onError.then?.kind === "route";
  return false;
}

const errorPort = (): Port => ({ id: "error", kind: "control", direction: "out", name: "error" });

/**
 * The full port list for a node: its authored static ports plus the dynamic
 * ports derived from config. Derived port ids follow the IR conventions that
 * edges reference (`route:<id>`, `branch:<id>`, `branch:else`, `approved`,
 * `rejected`, `error`, `fields.<id>`).
 */
export function derivePorts(node: WorkflowNode): Port[] {
  const derived: Port[] = [];

  switch (node.type) {
    case "router": {
      for (const route of node.config.routes) {
        derived.push({ id: `route:${route.id}`, kind: "control", direction: "out", name: route.name });
      }
      break;
    }
    case "conditional": {
      for (const branch of node.config.branches) {
        derived.push({
          id: `branch:${branch.id}`,
          kind: "control",
          direction: "out",
          name: branch.name ?? branch.id,
        });
      }
      if (node.config.hasElse) {
        derived.push({ id: "branch:else", kind: "control", direction: "out", name: "else" });
      }
      break;
    }
    case "humanApproval": {
      derived.push({ id: "approved", kind: "control", direction: "out", name: "approved" });
      derived.push({ id: "rejected", kind: "control", direction: "out", name: "rejected" });
      break;
    }
    case "humanInput": {
      for (const field of node.config.fields) {
        derived.push({
          id: `fields.${field.id}`,
          kind: "data",
          direction: "out",
          name: field.name,
          dataType: field.dataType,
        });
      }
      break;
    }
    case "llm":
    case "tool":
    case "agentLoop": {
      if (routesError(node.config.onError)) derived.push(errorPort());
      break;
    }
    default:
      break;
  }

  return [...node.ports, ...derived];
}

/** The registry entry for a node type. */
export function nodeDef(type: NodeType): NodeDefinition {
  return NODE_TYPES[type];
}

/**
 * Build a fresh WorkflowNode from its type, seeding ports and config from the
 * registry defaults (deep-cloned so instances never alias the registry). The
 * single cast lives here: TS can't correlate the runtime `type` with its config
 * member, but the registry guarantees they match by construction.
 */
export function createNode(type: NodeType, id: string, layout: NodeLayout): WorkflowNode {
  const def = NODE_TYPES[type];
  return {
    id,
    type,
    layout,
    ports: def.staticPorts.map((p) => ({ ...p })),
    config: structuredClone(def.defaultConfig),
  } as WorkflowNode;
}
