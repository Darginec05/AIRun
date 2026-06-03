// IR → TypeScript on @airun/sdk.
//
// compileWorkflow(graph) walks the control-flow graph from the trigger and emits
// a `defineWorkflow({...})` module. The walker expands the graph into structured
// TS: linear chains → sequential awaits, conditional/router/approval → if-trees,
// output nodes → `return`. Bindings resolve to expressions; tools, schemas and
// state become module-level consts. Imports are accumulated and printed once.
//
// v1 scope: trigger, llm, tool, transform, state, conditional, router,
// humanApproval, humanInput, agentLoop, output. parallel/loop/subworkflow throw a
// CompileError until the dynamic-fan-out / loop / cross-module passes land.

import { assertValidWorkflow } from "@airun/schema";
import type {
  Binding,
  CompareOp,
  Condition,
  DataType,
  HttpToolDef,
  JSONSchema,
  JSONValue,
  StopCondition,
  SystemPrompt,
  ToolDef,
  TransformSpec,
  WorkflowGraph,
  WorkflowNode,
} from "@airun/schema";

export class CompileError extends Error {}

export interface CompileOptions {
  /** Module specifier the generated code imports the SDK from. */
  sdkModule?: string;
}

const COMPARE: Record<CompareOp, string> = {
  eq: "===",
  neq: "!==",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "contains",
  in: "in",
};

const RESERVED = new Set(["default", "case", "return", "function", "class", "new", "delete", "void", "in"]);

// Identifiers the generated module already binds (SDK imports + the trigger's
// `event` param). Every emitted name is allocated around these so it can never
// shadow them.
const SDK_GLOBALS = ["event", "ai", "step", "tool", "state", "trigger", "defineWorkflow", "Schema"];

function sanitizeIdent(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(s)) s = `_${s}`;
  if (s === "" || RESERVED.has(s)) s = `_${s}`;
  return s;
}

function camelCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "workflow";
  const head = parts[0]!.toLowerCase();
  const tail = parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1));
  return sanitizeIdent(head + tail.join(""));
}

function indent(lines: string[]): string[] {
  return lines.map((l) => (l === "" ? "" : `  ${l}`));
}

class Compiler {
  private readonly graph: WorkflowGraph;
  private readonly sdkModule: string;
  private readonly nodeById = new Map<string, WorkflowNode>();
  private readonly imports = { value: new Set<string>(), type: new Set<string>() };
  private readonly extraImports = new Map<string, Set<string>>(); // module -> symbols (fn tools)
  private readonly usedSchemas = new Set<string>();
  private readonly path = new Set<string>(); // cycle guard during the walk

  // One module-scope namespace shared by every emitted identifier. Allocated up
  // front so node / tool / state / schema names can never collide with one
  // another or with the SDK imports they sit beside.
  private readonly used = new Set<string>();
  private readonly nodeSym = new Map<string, string>();
  private readonly toolSym = new Map<string, string>();
  private readonly stateSym = new Map<string, string>();
  private readonly schemaSym = new Map<string, string>();
  private workflowExport = "workflow";

  // Set while emitting a synchronous arrow (stopWhen predicate, transform fn),
  // where `await state.get()` is illegal. Var reads are hoisted into `lines`
  // before the enclosing statement and referenced by a cached temp const.
  private hoist: { lines: string[]; cache: Map<string, string> } | null = null;

  constructor(graph: WorkflowGraph, opts: CompileOptions) {
    this.graph = graph;
    this.sdkModule = opts.sdkModule ?? "@airun/sdk";
    for (const n of graph.nodes) this.nodeById.set(n.id, n);
    this.allocateNames();
  }

  private allocateNames(): void {
    for (const g of SDK_GLOBALS) this.used.add(g);
    // fn-tool handlers are imported by their export name and can't be aliased
    // away, so reserve them first; everything else allocates around them.
    for (const t of this.graph.tools) {
      if (t.impl === "fn") this.used.add(t.exportName);
    }
    this.workflowExport = this.allocate(camelCase(this.graph.name));
    for (const n of this.graph.nodes) {
      if (n.type === "trigger") this.nodeSym.set(n.id, "event");
    }
    for (const n of this.graph.nodes) {
      if (n.type !== "trigger") this.nodeSym.set(n.id, this.allocate(n.id));
    }
    for (const t of this.graph.tools) this.toolSym.set(t.id, this.allocate(t.id));
    for (const v of this.graph.variables) this.stateSym.set(v.name, this.allocate(v.name));
    // Schema names are allocated lazily (schemaRef) so they yield to the names
    // above and only the schemas actually used get one.
  }

  private allocate(base: string): string {
    let name = sanitizeIdent(base);
    if (this.used.has(name)) {
      let i = 2;
      while (this.used.has(`${name}${i}`)) i++;
      name = `${name}${i}`;
    }
    this.used.add(name);
    return name;
  }

  private sym(nodeId: string): string {
    const s = this.nodeSym.get(nodeId);
    if (!s) throw new CompileError(`unknown node referenced: ${nodeId}`);
    return s;
  }

  private stateHandle(name: string): string {
    return this.stateSym.get(name) ?? this.allocate(name);
  }

  private withHoist(build: () => string): { expr: string; lines: string[] } {
    const prev = this.hoist;
    const scope = { lines: [] as string[], cache: new Map<string, string>() };
    this.hoist = scope;
    try {
      return { expr: build(), lines: scope.lines };
    } finally {
      this.hoist = prev;
    }
  }

  private use(symbol: string): void {
    this.imports.value.add(symbol);
  }

  // --- bindings ------------------------------------------------------------

  private resolve(b: Binding, toolArgs = false): string {
    switch (b.kind) {
      case "literal":
        return JSON.stringify(b.value);
      case "ref": {
        const s = this.sym(b.nodeId);
        return b.path ? `${s}.${b.path}` : s;
      }
      case "var": {
        if (toolArgs) return `args.${b.name}`;
        this.use("state");
        const handle = this.stateHandle(b.name);
        if (this.hoist) {
          // Synchronous arrow: can't await inline, so read once into a temp const
          // hoisted before the enclosing statement.
          let tmp = this.hoist.cache.get(b.name);
          if (!tmp) {
            tmp = this.allocate(`${b.name}Value`);
            this.hoist.lines.push(`const ${tmp} = await ${handle}.get();`);
            this.hoist.cache.set(b.name, tmp);
          }
          return tmp;
        }
        return `(await ${handle}.get())`;
      }
      case "template":
        return (
          "`" +
          b.segments
            .map((seg) =>
              seg.kind === "text"
                ? seg.value.replace(/[`\\$]/g, (c) => `\\${c}`)
                : "${" + this.resolve(seg.binding, toolArgs) + "}",
            )
            .join("") +
          "`"
        );
    }
  }

  private condition(c: Condition): string {
    switch (c.kind) {
      case "compare": {
        const l = this.resolve(c.left);
        const r = this.resolve(c.right);
        if (c.op === "contains") return `${l}.includes(${r})`;
        if (c.op === "in") return `${r}.includes(${l})`;
        return `${l} ${COMPARE[c.op]} ${r}`;
      }
      case "and":
        return c.conditions.map((x) => `(${this.condition(x)})`).join(" && ") || "true";
      case "or":
        return c.conditions.map((x) => `(${this.condition(x)})`).join(" || ") || "false";
      case "not":
        return `!(${this.condition(c.condition)})`;
      case "expr":
        return `(${c.source}) /* unsafe expr */`;
    }
  }

  private systemPrompt(sp: SystemPrompt): string {
    switch (sp.kind) {
      case "static":
        return JSON.stringify(sp.text);
      case "dynamic":
        return this.resolve(sp.binding);
      case "composed":
        return this.resolve({ kind: "template", segments: sp.segments });
    }
  }

  private schemaRef(id: string): string {
    this.usedSchemas.add(id);
    let s = this.schemaSym.get(id);
    if (!s) {
      s = this.allocate(id);
      this.schemaSym.set(id, s);
    }
    return s;
  }

  // --- control-flow walk ---------------------------------------------------

  private controlTargets(nodeId: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const e of this.graph.edges) {
      if (e.kind === "control" && e.from.nodeId === nodeId) m.set(e.from.portId, e.to.nodeId);
    }
    return m;
  }

  private next(nodeId: string): string | undefined {
    return this.controlTargets(nodeId).get("out");
  }

  private walk(nodeId: string): string[] {
    if (this.path.has(nodeId)) {
      throw new CompileError(`control cycle through '${nodeId}' is not supported by v1 codegen`);
    }
    const node = this.nodeById.get(nodeId);
    if (!node) throw new CompileError(`edge points at missing node '${nodeId}'`);
    this.path.add(nodeId);
    try {
      return this.emit(node);
    } finally {
      this.path.delete(nodeId);
    }
  }

  private continueAfter(nodeId: string): string[] {
    const n = this.next(nodeId);
    return n ? this.walk(n) : [];
  }

  private emit(node: WorkflowNode): string[] {
    switch (node.type) {
      case "trigger":
        return this.continueAfter(node.id);

      case "output":
        return [`return ${this.resolve(node.config.value)};`];

      case "llm": {
        this.use("ai");
        const c = node.config;
        const opts: string[] = [`model: ${this.resolve(c.model)},`];
        if (c.systemPrompt) opts.push(`system: ${this.systemPrompt(c.systemPrompt)},`);
        opts.push(`prompt: ${this.resolve(c.prompt)},`);
        if (c.temperature) opts.push(`temperature: ${this.resolve(c.temperature)},`);
        if (c.maxTokens) opts.push(`maxTokens: ${this.resolve(c.maxTokens)},`);
        if (c.output?.kind === "structured") opts.push(`schema: ${this.schemaRef(c.output.schema)},`);
        return [
          `const ${this.sym(node.id)} = await ai.generate({`,
          ...indent(opts),
          `});`,
          ...this.continueAfter(node.id),
        ];
      }

      case "tool": {
        const toolSym = this.toolSymbol(node.config.toolId);
        const args = Object.entries(node.config.args)
          .map(([k, b]) => `${k}: ${this.resolve(b)}`)
          .join(", ");
        return [
          `const ${this.sym(node.id)} = await ${toolSym}({ ${args} });`,
          ...this.continueAfter(node.id),
        ];
      }

      case "transform": {
        this.use("step");
        const input = this.resolve(node.config.input);
        const fn = this.withHoist(() => this.transformFn(node.config.transform));
        return [
          ...fn.lines,
          `const ${this.sym(node.id)} = step.transform(${input}, ${fn.expr});`,
          ...this.continueAfter(node.id),
        ];
      }

      case "state": {
        this.use("state");
        const h = this.stateHandle(node.config.variable);
        const op = node.config.operation;
        if (op === "get") {
          return [`const ${this.sym(node.id)} = await ${h}.get();`, ...this.continueAfter(node.id)];
        }
        const value = node.config.value ? this.resolve(node.config.value) : "undefined";
        return [`await ${h}.${op}(${value});`, ...this.continueAfter(node.id)];
      }

      case "humanInput": {
        this.use("step");
        const fields = node.config.fields
          .map((f) => `${f.id}: { type: ${JSON.stringify(this.fieldType(f.dataType))}${f.required ? ", required: true" : ""} }`)
          .join(", ");
        return [
          `const ${this.sym(node.id)} = await step.input({`,
          ...indent([`prompt: ${this.resolve(node.config.prompt)},`, `fields: { ${fields} },`]),
          `});`,
          ...this.continueAfter(node.id),
        ];
      }

      case "agentLoop": {
        this.use("ai");
        const c = node.config;
        const tools = c.toolIds.map((id) => this.toolSymbol(id)).join(", ");
        const opts: string[] = [`model: ${this.resolve(c.model)},`];
        if (c.systemPrompt) opts.push(`system: ${this.systemPrompt(c.systemPrompt)},`);
        opts.push(`prompt: ${this.resolve(c.prompt)},`);
        opts.push(`tools: [${tools}],`);
        const stop = this.withHoist(() => this.stopWhen(c.stopCondition));
        opts.push(`stopWhen: ${stop.expr},`);
        if (c.output?.kind === "structured") opts.push(`schema: ${this.schemaRef(c.output.schema)},`);
        return [
          ...stop.lines,
          `const ${this.sym(node.id)} = await ai.agent({`,
          ...indent(opts),
          `});`,
          ...this.continueAfter(node.id),
        ];
      }

      case "humanApproval": {
        this.use("step");
        const c = node.config;
        const opts: string[] = [`prompt: ${this.resolve(c.prompt)},`];
        if (c.assignee) opts.push(`assignee: ${this.resolve(c.assignee)},`);
        if (c.timeout) opts.push(`timeout: ${JSON.stringify(c.timeout)},`);
        if (c.onTimeout) opts.push(`onTimeout: ${JSON.stringify(c.onTimeout)},`);
        const s = this.sym(node.id);
        const targets = this.controlTargets(node.id);
        return [
          `const ${s} = await step.approval({`,
          ...indent(opts),
          `});`,
          `if (${s}.approved) {`,
          ...indent(this.branch(targets.get("approved"))),
          `} else {`,
          ...indent(this.branch(targets.get("rejected"))),
          `}`,
        ];
      }

      case "conditional": {
        const targets = this.controlTargets(node.id);
        const lines: string[] = [];
        node.config.branches.forEach((b, i) => {
          const head = i === 0 ? "if" : "} else if";
          lines.push(`${head} (${this.condition(b.condition)}) {`);
          lines.push(...indent(this.branch(targets.get(`branch:${b.id}`))));
        });
        if (node.config.hasElse) {
          lines.push(`} else {`);
          lines.push(...indent(this.branch(targets.get("branch:else"))));
        }
        lines.push(`}`);
        return lines;
      }

      case "router": {
        const c = node.config;
        const targets = this.controlTargets(node.id);
        const lines: string[] = [];
        if (c.mode === "classify") {
          this.use("ai");
          const s = this.sym(node.id);
          const labels = c.routes.map((r) => JSON.stringify(r.name)).join(", ");
          lines.push(`const ${s} = await ai.classify({`);
          lines.push(...indent([`model: ${c.model ? this.resolve(c.model) : '""'},`, `input: ${this.resolve(c.input)},`, `labels: [${labels}],`]));
          lines.push(`});`);
          c.routes.forEach((r, i) => {
            const head = i === 0 ? "if" : "} else if";
            lines.push(`${head} (${s} === ${JSON.stringify(r.name)}) {`);
            lines.push(...indent(this.branch(targets.get(`route:${r.id}`))));
          });
          lines.push(`}`);
        } else {
          c.routes.forEach((r, i) => {
            const head = i === 0 ? "if" : "} else if";
            lines.push(`${head} (${r.condition ? this.condition(r.condition) : "true"}) {`);
            lines.push(...indent(this.branch(targets.get(`route:${r.id}`))));
          });
          if (c.fallbackRouteId) {
            lines.push(`} else {`);
            lines.push(...indent(this.branch(targets.get(`route:${c.fallbackRouteId}`))));
          }
          lines.push(`}`);
        }
        return lines;
      }

      case "parallel":
      case "loop":
      case "subworkflow":
        throw new CompileError(`node type '${node.type}' is not supported by v1 codegen yet (node '${node.id}')`);
    }
  }

  private branch(target: string | undefined): string[] {
    return target ? this.walk(target) : [];
  }

  private transformFn(spec: TransformSpec): string {
    switch (spec.kind) {
      case "fn":
        this.addExtraImport(spec.module, spec.exportName);
        return spec.exportName;
      case "pick":
        return `(input) => ({ ${spec.paths.map((p) => `${p}: input.${p}`).join(", ")} })`;
      case "map":
        return `(input) => ({ ${Object.entries(spec.mapping).map(([k, b]) => `${k}: ${this.resolve(b)}`).join(", ")} })`;
      case "expr":
        return `(input) => (${spec.source}) /* unsafe expr */`;
    }
  }

  private stopWhen(s: StopCondition): string {
    switch (s.kind) {
      case "maxSteps":
        return `{ kind: "maxSteps", value: ${s.value} }`;
      case "noToolUse":
        return `{ kind: "noToolUse" }`;
      case "toolCalled":
        return `{ kind: "toolCalled", tool: ${this.toolSymbol(s.toolId)} }`;
      case "condition":
        return `{ kind: "condition", predicate: () => ${this.condition(s.condition)} }`;
      case "any":
        return `{ kind: "any", conditions: [${s.conditions.map((c) => this.stopWhen(c)).join(", ")}] }`;
    }
  }

  private fieldType(dt: DataType): string {
    if (typeof dt === "object") return "json";
    if (dt === "string" || dt === "number" || dt === "boolean") return dt;
    return "json";
  }

  /** JSON Schema → a TypeScript type expression (best-effort, inline). */
  private tsType(schema: JSONValue | undefined): string {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "unknown";
    const s = schema as JSONSchema;
    switch (s.type) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return `${this.tsType(s.items)}[]`;
      case "object": {
        const props = (s.properties ?? {}) as Record<string, JSONValue>;
        const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
        const entries = Object.entries(props);
        if (entries.length === 0) return "Record<string, unknown>";
        const fields = entries.map(
          ([k, v]) => `${JSON.stringify(k)}${required.has(k) ? "" : "?"}: ${this.tsType(v)}`,
        );
        return `{ ${fields.join("; ")} }`;
      }
      default:
        return "unknown";
    }
  }

  private emitSchemaDefs(): string[] {
    const lines: string[] = [];
    for (const id of this.usedSchemas) {
      const name = this.schemaSym.get(id) ?? id;
      const schema = this.graph.schemas[id];
      lines.push(`type ${name} = ${this.tsType(schema)};`);
      lines.push(`const ${name}: Schema<${name}> = { parse: (x) => x as ${name} }; // TODO: validate at runtime`);
    }
    return lines;
  }

  // --- module-level consts -------------------------------------------------

  private toolSymbol(toolId: string): string {
    const s = this.toolSym.get(toolId);
    if (!s) throw new CompileError(`unknown tool referenced: ${toolId}`);
    return s;
  }

  private addExtraImport(module: string, symbol: string): void {
    let set = this.extraImports.get(module);
    if (!set) {
      set = new Set();
      this.extraImports.set(module, set);
    }
    set.add(symbol);
  }

  /** `<TArgs, TResult>` suffix carrying an http tool's declared output type, so a
   *  ref into its result keeps its shape. Args stay loosely typed: a tool def is
   *  reusable, its args come from the invoking node, not the registry. fn tools
   *  don't need it — TResult infers from the handler's return type. */
  private toolGenerics(t: HttpToolDef): string {
    return t.outputSchema ? `<Record<string, unknown>, ${this.schemaRef(t.outputSchema)}>` : "";
  }

  private emitTool(t: ToolDef): string[] {
    if (t.impl === "fn") {
      this.use("tool");
      this.addExtraImport(t.module, t.exportName);
      return [
        `const ${this.toolSymbol(t.id)} = tool.fn({`,
        ...indent([
          `id: ${JSON.stringify(t.id)},`,
          `name: ${JSON.stringify(t.name)},`,
          `handler: ${t.exportName},`,
        ]),
        `});`,
      ];
    }
    return this.emitHttpTool(t);
  }

  private emitHttpTool(t: HttpToolDef): string[] {
    this.use("tool");
    const opts: string[] = [
      `id: ${JSON.stringify(t.id)},`,
      `name: ${JSON.stringify(t.name)},`,
      `method: ${this.resolve(t.method)},`,
      `url: ${this.resolve(t.url)},`,
    ];
    if (t.headers) {
      const entries = Object.entries(t.headers).map(([k, v]) => `${JSON.stringify(k)}: ${this.resolve(v)}`);
      opts.push(`headers: { ${entries.join(", ")} },`);
    }
    if (t.query) {
      const entries = Object.entries(t.query).map(([k, v]) => `${JSON.stringify(k)}: ${this.resolve(v)}`);
      opts.push(`query: { ${entries.join(", ")} },`);
    }
    if (t.body) opts.push(`body: (args) => ${this.resolve(t.body, true)},`);
    if (t.auth) opts.push(`auth: { secret: ${JSON.stringify(t.auth.name)} },`);
    return [`const ${this.toolSymbol(t.id)} = tool.http${this.toolGenerics(t)}({`, ...indent(opts), `});`];
  }

  private emitStateConst(): string[] {
    const lines: string[] = [];
    for (const v of this.graph.variables) {
      this.use("state");
      const initial = v.initial ? `, initial: ${this.resolve(v.initial)}` : "";
      lines.push(`const ${this.stateHandle(v.name)} = state<${this.stateType(v)}>(${JSON.stringify(v.name)}, { scope: ${JSON.stringify(v.scope)}${initial} });`);
    }
    return lines;
  }

  /** Best-effort TS type for a variable handle. `json` falls back to the shape
   *  of its initial literal so array variables keep a usable `append`. */
  private stateType(v: WorkflowGraph["variables"][number]): string {
    const dt = v.dataType;
    if (typeof dt === "object") return this.schemaRef(dt.schema);
    if (dt === "string" || dt === "number" || dt === "boolean") return dt;
    if (v.initial?.kind === "literal") {
      const value = v.initial.value;
      if (Array.isArray(value)) return "unknown[]";
      if (value && typeof value === "object") return "Record<string, unknown>";
    }
    return "unknown";
  }

  private triggerOn(node: Extract<WorkflowNode, { type: "trigger" }>): string {
    this.use("trigger");
    const t = node.config.trigger;
    switch (t.kind) {
      case "event":
        return t.inputSchema
          ? `trigger.onEvent(${JSON.stringify(t.eventName)}, ${this.schemaRef(t.inputSchema)})`
          : `trigger.onEvent(${JSON.stringify(t.eventName)})`;
      case "schedule":
        return t.timezone
          ? `trigger.onSchedule(${JSON.stringify(t.cron)}, { timezone: ${JSON.stringify(t.timezone)} })`
          : `trigger.onSchedule(${JSON.stringify(t.cron)})`;
      case "webhook": {
        const schema = t.inputSchema ? `, schema: ${this.schemaRef(t.inputSchema)}` : "";
        return `trigger.onWebhook({ path: ${JSON.stringify(t.path)}, method: ${JSON.stringify(t.method)}${schema} })`;
      }
    }
  }

  // --- assembly ------------------------------------------------------------

  compile(): string {
    const trigger = this.graph.nodes.find((n) => n.type === "trigger");
    if (!trigger || trigger.type !== "trigger") throw new CompileError("workflow has no trigger node");

    this.use("defineWorkflow");

    // Order matters: walk first so imports / used schemas are populated.
    const start = this.next(trigger.id);
    const body = start ? this.walk(start) : [`return undefined;`];
    const onExpr = this.triggerOn(trigger);
    const tools = this.graph.tools.flatMap((t) => this.emitTool(t));
    const stateConsts = this.emitStateConst();

    if (this.usedSchemas.size > 0) this.imports.type.add("Schema");

    const schemaConsts = this.emitSchemaDefs();

    const exportName = this.workflowExport;
    const defLines = [
      `export const ${exportName} = defineWorkflow({`,
      ...indent([
        `id: ${JSON.stringify(this.graph.id)},`,
        `name: ${JSON.stringify(this.graph.name)},`,
        `on: ${onExpr},`,
        `run: async ({ event }) => {`,
        ...indent(body),
        `},`,
      ]),
      `});`,
    ];

    const out: string[] = [this.importHeader(), ""];
    const section = (title: string, lines: string[]) => {
      if (lines.length === 0) return;
      out.push(`// --- ${title} ---`, ...lines, "");
    };
    section("schemas", schemaConsts);
    section("tools", tools);
    section("state", stateConsts);
    out.push(...defLines, "");
    return out.join("\n");
  }

  private importHeader(): string {
    const value = [...this.imports.value].sort();
    const type = [...this.imports.type].sort().map((t) => `type ${t}`);
    const names = [...value, ...type].join(", ");
    const lines = [`import { ${names} } from ${JSON.stringify(this.sdkModule)};`];
    for (const [module, symbols] of this.extraImports) {
      lines.push(`import { ${[...symbols].sort().join(", ")} } from ${JSON.stringify(module)};`);
    }
    return lines.join("\n");
  }
}

export function compileWorkflow(graph: WorkflowGraph, opts: CompileOptions = {}): string {
  assertValidWorkflow(graph);
  return new Compiler(graph, opts).compile();
}
