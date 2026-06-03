// @airun/schema — the WorkflowGraph IR (v1).
//
// The single source of truth: a plain-JSON contract the visual editor emits and
// the compiler consumes. Three layers live here:
//   1. Graph IR        — nodes, edges, variables, tools, schemas, secrets.
//   2. Layout          — purely visual (x/y/size); never affects execution.
//   3. Codegen surface — EmitContext / NodeEmitter for the IR→code compiler.
//
// Design invariants (enforced by validators, see WORKFLOW_INVARIANTS):
//   - Data flow is a DAG. Control flow may contain cycles (loops).
//   - `edges` is the ONLY source of truth for graph structure. Subgraph membership
//     (loop body, parallel branches, conditional branches) is expressed by control
//     edges into/out of derived ports — never duplicated as id lists in config.
//   - Edges reference stable port ids, never display labels.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/** Identifier into the workflow's SchemaRegistry. */
export type SchemaId = string;

/**
 * Shape of a value flowing along a data edge / data port.
 * Structured values reference a named JSON Schema rather than the opaque "json".
 */
export type DataType =
  | "string"
  | "number"
  | "boolean"
  | "json" // opaque structured value, shape unknown to the graph
  | "conversation" // ordered chat-message array (renamed from "messages")
  | "any"
  | { kind: "schema"; schema: SchemaId };

/** Duration literal, single unit only, e.g. "30s", "5m", "1h". */
export type DurationUnit = "ms" | "s" | "m" | "h" | "d";
export type Duration = `${number}${DurationUnit}`;

// ---------------------------------------------------------------------------
// Bindings — how config values are sourced
// ---------------------------------------------------------------------------

/**
 * A Binding is the ONLY way to express a config value. There is no bare `T`:
 * even constants are wrapped in { kind: "literal" } so a literal object can never
 * be confused with a Binding.
 */
export type Binding =
  | { kind: "literal"; value: JSONValue }
  | { kind: "ref"; nodeId: string; path?: string } // output of another node (path = dot-path into it)
  | { kind: "var"; name: string } // a workflow variable
  | { kind: "template"; segments: TemplateSegment[] }; // parsed string interpolation

/** A template / composed string, parsed into segments — never a raw "${...}" string. */
export type TemplateSegment =
  | { kind: "text"; value: string }
  | { kind: "expr"; binding: Binding };

/**
 * Bound<T> is always a Binding. The type parameter is phantom: it documents the
 * expected *resolved* type for tooling and codegen, and carries no runtime shape.
 */
export type Bound<T = JSONValue> = Binding & { readonly __resolved?: T };

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export type CompareOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "in";

export type Condition =
  | { kind: "compare"; op: CompareOp; left: Binding; right: Binding }
  | { kind: "and"; conditions: Condition[] }
  | { kind: "or"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  // Escape hatch. Sandboxed at runtime; `unsafe` makes the risk explicit at the type level.
  | { kind: "expr"; unsafe: true; language: "js"; source: string };

// ---------------------------------------------------------------------------
// Ports & edges
// ---------------------------------------------------------------------------

export type PortKind = "control" | "data";
export type PortDirection = "in" | "out";

/**
 * A port on a node. `ports[]` on a node holds ONLY static ports. Dynamic ports
 * (router routes, conditional branches, approval approved/rejected, error outs,
 * human-input fields) are DERIVED from config by @airun/node-registry and are not
 * authored here. Derived port ids follow documented conventions, e.g.:
 *   route:<routeId>  branch:<branchId>  branch:else  approved  rejected  error
 */
export interface Port {
  id: string; // stable, unique within the node
  kind: PortKind;
  direction: PortDirection;
  name: string; // display label + codegen symbol hint
  dataType?: DataType; // required when kind === "data"
}

export interface PortRef {
  nodeId: string;
  portId: string;
}

/**
 * A directed edge. `kind` is denormalized for rendering (control = solid/animated,
 * data = thin/dashed) and MUST match the kind of both endpoint ports (validated).
 * Data edges additionally require compatible dataTypes at both ends.
 */
export interface Edge {
  id: string;
  kind: PortKind;
  from: PortRef;
  to: PortRef;
}

// ---------------------------------------------------------------------------
// Variables, schemas, secrets
// ---------------------------------------------------------------------------

export type VariableScope = "run" | "session" | "persistent";

export interface VariableDef {
  name: string;
  scope: VariableScope;
  dataType: DataType;
  initial?: Binding;
  description?: string;
}

/** A JSON Schema document (draft 2020-12). Kept opaque to the IR. */
export type JSONSchema = { [key: string]: JSONValue };

/** Named JSON Schemas referenced by SchemaId across the graph. */
export type SchemaRegistry = Record<SchemaId, JSONSchema>;

/** Reference to a secret resolved at runtime from the secret store — never inlined into codegen. */
export interface SecretRef {
  kind: "secret";
  name: string;
}

/** A secret the workflow requires at runtime (value lives in the secret store, not here). */
export interface SecretDef {
  name: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Tools — definition separated from invocation
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ToolDefBase {
  id: string;
  name: string;
  description?: string;
  inputSchema?: SchemaId;
  outputSchema?: SchemaId;
}

/**
 * Inside any ToolDef, a Binding of kind "var" resolves against the INVOKING node's
 * `args` (the tool's parameters), not against workflow variables. This keeps a tool
 * definition reusable: the def is a template; ToolNode.args supplies the values.
 */
export interface HttpToolDef extends ToolDefBase {
  impl: "http";
  method: Bound<HttpMethod>;
  url: Bound<string>;
  headers?: Record<string, Bound<string>>;
  query?: Record<string, Bound<string>>;
  body?: Binding;
  auth?: SecretRef;
}

/** A developer-owned function the codegen wires up by import. */
export interface FnToolDef extends ToolDefBase {
  impl: "fn";
  module: string;
  exportName: string;
}

export type ToolDef = HttpToolDef | FnToolDef;

// ---------------------------------------------------------------------------
// Error handling — first-class
// ---------------------------------------------------------------------------

export interface Backoff {
  strategy: "fixed" | "exponential";
  delay: Duration;
  factor?: number; // exponential only
}

/** What happens after retries are exhausted, or for non-retry policies. */
export type ErrorFallback =
  | { kind: "value"; value: Binding } // substitute a value and continue
  | { kind: "route" }; // emit on the derived "error" control out-port

/**
 * Attached to fallible nodes (llm, tool, agentLoop, subworkflow). A policy of
 * "catch"/"route" causes a derived "error" control out-port to exist on the node.
 */
export type ErrorPolicy =
  | { kind: "throw" } // default: propagate and fail the run
  | { kind: "retry"; maxAttempts: number; backoff?: Backoff; then?: ErrorFallback }
  | { kind: "fallback"; fallback: ErrorFallback }
  | { kind: "catch" }; // always route to the "error" out-port

// ---------------------------------------------------------------------------
// Prompts & LLM output
// ---------------------------------------------------------------------------

export type SystemPrompt =
  | { kind: "static"; text: string }
  | { kind: "dynamic"; binding: Binding }
  | { kind: "composed"; segments: TemplateSegment[] }; // unified with template segments

/** Structured output references a real JSON Schema, never DataType "json". */
export type LLMOutput =
  | { kind: "text" }
  | { kind: "structured"; schema: SchemaId };

// ---------------------------------------------------------------------------
// Stop conditions (agent loop) — aligned with the SDK's stopWhen
// ---------------------------------------------------------------------------

export type StopCondition =
  | { kind: "maxSteps"; value: number }
  | { kind: "noToolUse" } // stop when the model stops calling tools
  | { kind: "toolCalled"; toolId: string } // stop when a terminal tool fires
  | { kind: "condition"; condition: Condition }
  | { kind: "any"; conditions: StopCondition[] };

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface NodeLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface BaseNode {
  id: string;
  type: NodeType;
  label?: string;
  layout: NodeLayout;
  ports: Port[]; // static ports only; dynamic ports are derived from config
}

// --- trigger ---------------------------------------------------------------

export type TriggerSpec =
  | { kind: "event"; eventName: string; inputSchema?: SchemaId }
  | { kind: "schedule"; cron: string; timezone?: string }
  | { kind: "webhook"; path: string; method: HttpMethod; inputSchema?: SchemaId };

export interface TriggerNode extends BaseNode {
  type: "trigger";
  config: { trigger: TriggerSpec };
}

// --- llm -------------------------------------------------------------------

export interface LLMNode extends BaseNode {
  type: "llm";
  config: {
    model: Bound<string>;
    systemPrompt?: SystemPrompt;
    prompt: Bound<string>;
    output?: LLMOutput;
    temperature?: Bound<number>;
    maxTokens?: Bound<number>;
    onError?: ErrorPolicy;
  };
}

// --- router ----------------------------------------------------------------

export interface RouteCase {
  id: string; // stable; derived out-port = "route:" + id (edges reference this)
  name: string; // display + label used by classify mode
  condition?: Condition; // mode "condition"
  description?: string; // mode "classify": semantics handed to the model
}

export interface RouterNode extends BaseNode {
  type: "router";
  config: {
    input: Binding;
    mode: "condition" | "classify";
    model?: Bound<string>; // required when mode === "classify"
    routes: RouteCase[];
    fallbackRouteId?: string;
  };
}

// --- tool (invocation) -----------------------------------------------------

export interface ToolNode extends BaseNode {
  type: "tool";
  config: {
    toolId: string; // references a ToolDef in the graph's tool registry
    args: Record<string, Binding>;
    onError?: ErrorPolicy;
  };
}

// --- agentLoop -------------------------------------------------------------

export interface AgentLoopNode extends BaseNode {
  type: "agentLoop";
  config: {
    model: Bound<string>;
    systemPrompt?: SystemPrompt;
    prompt: Bound<string>;
    toolIds: string[]; // tools available in the loop (reference the registry)
    stopCondition: StopCondition;
    output?: LLMOutput;
    onError?: ErrorPolicy;
  };
}

// --- parallel (static branches OR dynamic map) -----------------------------

export type AggregateStrategy =
  | { kind: "merge" } // collect results into an array
  | { kind: "object"; keys: string[] } // collect into a keyed object (branches mode)
  | { kind: "vote"; tally: "majority" | "unanimous" }
  | { kind: "reduce"; reducer: { module: string; exportName: string } }
  | { kind: "first" }; // race — first to complete wins

export interface ParallelNode extends BaseNode {
  type: "parallel";
  config: {
    // "branches": fixed concurrent branches; structure expressed entirely by the
    //   control edges out of derived "branch:*" ports, joined at this node's "join" in-port.
    // "map": dynamic fan-out over a collection (orchestrator-workers).
    mode: "branches" | "map";
    over?: Binding; // mode "map": the collection
    itemVar?: string; // mode "map": variable bound to each item inside the body
    maxConcurrency?: number;
    aggregate: AggregateStrategy;
  };
}

// --- conditional -----------------------------------------------------------

export interface ConditionalBranch {
  id: string; // stable; derived out-port = "branch:" + id
  name?: string;
  condition: Condition;
}

export interface ConditionalNode extends BaseNode {
  type: "conditional";
  config: {
    branches: ConditionalBranch[]; // predicates + order only; bodies live in the edges
    hasElse: boolean; // when true a derived "branch:else" out-port exists
  };
}

// --- loop ------------------------------------------------------------------

export interface LoopNode extends BaseNode {
  type: "loop";
  config: {
    // Body is whatever the "body" out-port reaches before returning to "continue";
    // exit flows from the "done" out-port. Membership is never listed here.
    mode: "while" | "forEach" | "count";
    condition?: Condition; // while
    collection?: Binding; // forEach
    itemVar?: string; // forEach
    count?: Bound<number>; // count
    maxIterations?: number; // safety bound
  };
}

// --- humanApproval ---------------------------------------------------------

export interface HumanApprovalNode extends BaseNode {
  type: "humanApproval";
  config: {
    prompt: Bound<string>;
    // derived control out-ports: "approved", "rejected"
    assignee?: Bound<string>;
    timeout?: Duration;
    onTimeout?: "approve" | "reject" | "escalate";
  };
}

// --- humanInput ------------------------------------------------------------

export interface InputField {
  id: string; // stable; output path = "fields." + id
  name: string; // display label
  dataType: DataType;
  required?: boolean;
  default?: Binding;
}

export interface HumanInputNode extends BaseNode {
  type: "humanInput";
  config: {
    prompt: Bound<string>;
    fields: InputField[];
    assignee?: Bound<string>;
    timeout?: Duration;
  };
}

// --- state -----------------------------------------------------------------

export interface StateNode extends BaseNode {
  type: "state";
  config: {
    variable: string; // VariableDef.name
    operation: "get" | "set" | "append" | "merge";
    value?: Binding; // required for set/append/merge
  };
}

// --- transform -------------------------------------------------------------

export type TransformSpec =
  | { kind: "fn"; module: string; exportName: string }
  | { kind: "pick"; paths: string[] }
  | { kind: "map"; mapping: Record<string, Binding> }
  // Escape hatch. Sandboxed; `unsafe` flags it at the type level.
  | { kind: "expr"; unsafe: true; language: "js"; source: string };

export interface TransformNode extends BaseNode {
  type: "transform";
  config: {
    input: Binding;
    transform: TransformSpec;
  };
}

// --- subworkflow -----------------------------------------------------------

export interface SubworkflowNode extends BaseNode {
  type: "subworkflow";
  config: {
    workflowId: string;
    version?: string;
    inputs: Record<string, Binding>; // validated against the child trigger's inputSchema
  };
}

// --- output ----------------------------------------------------------------

export interface OutputNode extends BaseNode {
  type: "output";
  config: {
    value: Binding;
    schema?: SchemaId;
  };
}

export type WorkflowNode =
  | TriggerNode
  | LLMNode
  | RouterNode
  | ToolNode
  | AgentLoopNode
  | ParallelNode
  | ConditionalNode
  | LoopNode
  | HumanApprovalNode
  | HumanInputNode
  | StateNode
  | TransformNode
  | SubworkflowNode
  | OutputNode;

export type NodeType = WorkflowNode["type"];

// ---------------------------------------------------------------------------
// Graph envelope
// ---------------------------------------------------------------------------

export interface GraphMetadata {
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  authoredBy?: string;
}

export interface WorkflowGraph {
  id: string;
  name: string;
  version: string; // semver of THIS workflow definition
  schemaVersion: 1; // version of the IR format itself
  nodes: WorkflowNode[];
  edges: Edge[];
  variables: VariableDef[];
  tools: ToolDef[]; // definitions referenced by tool / agentLoop nodes
  schemas: SchemaRegistry; // named JSON Schemas referenced by SchemaId
  secrets: SecretDef[]; // secret names the run requires
  metadata: GraphMetadata;
}

// ---------------------------------------------------------------------------
// Codegen surface (consumed by @airun/compiler)
// ---------------------------------------------------------------------------

export type CodegenTarget = "typescript";

/** module specifier -> set of imported symbols. */
export type ImportMap = Map<string, Set<string>>;

export interface CodeFragment {
  code: string;
  imports: ImportMap;
}

export interface EmitContext {
  graph: WorkflowGraph;
  target: CodegenTarget;
  /** Resolve a binding to a target-language expression. */
  resolve(binding: Binding): string;
  /** Stable identifier for a node's result value. */
  symbolFor(nodeId: string): string;
  /** Record an import; accumulated into the emitted module header. */
  addImport(module: string, symbol: string): void;
  /** Look up a registered JSON Schema. */
  schema(id: SchemaId): JSONSchema;
}

export type NodeEmitter<N extends WorkflowNode = WorkflowNode> = (
  node: N,
  ctx: EmitContext,
) => CodeFragment;

// ---------------------------------------------------------------------------
// Validator invariants — the rules a graph validator must enforce.
// (Descriptions for now; the executable validator lands with zod in a later pass.)
// ---------------------------------------------------------------------------

export * from "./validate.js";

export interface Invariant {
  id: string;
  description: string;
}

export const WORKFLOW_INVARIANTS: readonly Invariant[] = [
  { id: "single-trigger", description: "Exactly one node of type 'trigger' exists." },
  { id: "unique-ids", description: "Node ids, edge ids, variable names, tool ids, and schema ids are each unique." },
  { id: "edge-endpoints-exist", description: "Every edge endpoint references an existing node and a port (static or derived) on it." },
  { id: "edge-kind-match", description: "edge.kind equals the kind of both endpoint ports (control↔control, data↔data)." },
  { id: "edge-direction", description: "Edges go from an 'out' port to an 'in' port." },
  { id: "data-type-compat", description: "Data edges connect compatible dataTypes (or 'any' on either side)." },
  { id: "data-is-dag", description: "The data-flow subgraph is acyclic." },
  { id: "control-cycles-only-via-loop", description: "Control-flow cycles are permitted only through a loop node's body/continue ports." },
  { id: "ref-targets-exist", description: "Every Binding 'ref' targets an existing node with a reachable, type-compatible output." },
  { id: "var-declared", description: "Every Binding 'var' and state-node variable references a declared VariableDef." },
  { id: "tool-ids-resolve", description: "tool/agentLoop node toolId(s) resolve to a ToolDef in the registry." },
  { id: "schema-ids-resolve", description: "Every SchemaId used resolves to an entry in the SchemaRegistry." },
  { id: "secret-refs-declared", description: "Every SecretRef references a declared SecretDef." },
  { id: "subworkflow-inputs-match", description: "Subworkflow inputs satisfy the child trigger's inputSchema." },
  { id: "classify-needs-model", description: "Router/agent classification requires a model binding." },
  { id: "structured-output-schema", description: "Structured LLM output references a real schema, not DataType 'json'." },
  { id: "loop-bounds", description: "while/count loops declare a maxIterations / count bound." },
] as const;
