import { describe, expect, it } from "vitest";
import type { WorkflowGraph, WorkflowNode, Edge } from "@airun/schema";
import { compileWorkflow, CompileError } from "../src/compile.js";

// The example fixtures are imported from the built schema dist (real .js files);
// they are the same graphs `yarn typecheck` validates and the round-trip
// generated files in @airun/sdk are produced from.
import { invoiceGraph } from "../../schema/dist/examples/invoice.graph.js";
import { landingGraph } from "../../schema/dist/examples/landing.graph.js";

// --- tiny graph builders ----------------------------------------------------

const triggerNode: WorkflowNode = {
  id: "trigger",
  type: "trigger",
  layout: { x: 0, y: 0 },
  ports: [{ id: "out", kind: "control", direction: "out", name: "out" }],
  config: { trigger: { kind: "event", eventName: "go" } },
};

const ctl = (id: string, from: string, to: string): Edge => ({
  id,
  kind: "control",
  from: { nodeId: from, portId: "out" },
  to: { nodeId: to, portId: "in" },
});

function graph(nodes: WorkflowNode[], edges: Edge[], over: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    id: "wf_test",
    name: "Test Workflow",
    version: "1.0.0",
    schemaVersion: 1,
    nodes: [triggerNode, ...nodes],
    edges,
    variables: [],
    tools: [],
    schemas: {},
    secrets: [],
    metadata: {},
    ...over,
  };
}

const inOutPorts = [
  { id: "in", kind: "control", direction: "in", name: "in" },
  { id: "out", kind: "control", direction: "out", name: "out" },
] as const;

// --- example round-trips ----------------------------------------------------

describe("example graphs", () => {
  it("compiles the invoice workflow", () => {
    const out = compileWorkflow(invoiceGraph as WorkflowGraph, { sdkModule: "@airun/sdk" });
    expect(out).toContain("export const invoiceProcessing = defineWorkflow(");
    expect(out).toContain("await ai.generate(");
    expect(out).toContain("await step.approval(");
    expect(out).toContain("await postLedger(");
    expect(out).toContain("await processed.append(");
  });

  it("compiles the landing-page workflow with an agent loop and fn-tools", () => {
    const out = compileWorkflow(landingGraph as WorkflowGraph, { sdkModule: "@airun/sdk" });
    expect(out).toContain("export const landingPageBuilder = defineWorkflow(");
    expect(out).toContain("await ai.agent(");
    expect(out).toContain('import { finalizeSiteHandler, lintCheckHandler, writeComponentHandler } from "./site-tools.js";');
    // fn-tool const names dodge the imported handler names.
    expect(out).toContain("const writeComponent = tool.fn(");
    expect(out).toContain("handler: writeComponentHandler,");
  });
});

// --- bug #1: module-scope name collisions -----------------------------------

describe("name allocation", () => {
  it("renames a node that collides with an SDK import", () => {
    const out = compileWorkflow(
      graph(
        [
          {
            id: "ai",
            type: "llm",
            layout: { x: 1, y: 0 },
            ports: [...inOutPorts],
            config: { model: { kind: "literal", value: "m" }, prompt: { kind: "literal", value: "hi" } },
          },
          {
            id: "out",
            type: "output",
            layout: { x: 2, y: 0 },
            ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
            config: { value: { kind: "ref", nodeId: "ai" } },
          },
        ],
        [ctl("e1", "trigger", "ai"), ctl("e2", "ai", "out")],
      ),
    );
    // `ai` is reserved by the import, so the node becomes `ai2` — the call site
    // still uses the imported `ai.generate`.
    expect(out).toContain("const ai2 = await ai.generate(");
    expect(out).toContain("return ai2;");
  });

  it("gives a tool and a same-named node distinct symbols", () => {
    const out = compileWorkflow(
      graph(
        [
          {
            id: "deploy",
            type: "tool",
            layout: { x: 1, y: 0 },
            ports: [...inOutPorts],
            config: { toolId: "deploy", args: {} },
          },
          {
            id: "out",
            type: "output",
            layout: { x: 2, y: 0 },
            ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
            config: { value: { kind: "ref", nodeId: "deploy" } },
          },
        ],
        [ctl("e1", "trigger", "deploy"), ctl("e2", "deploy", "out")],
        {
          tools: [
            {
              id: "deploy",
              name: "Deploy",
              impl: "http",
              method: { kind: "literal", value: "GET" },
              url: { kind: "literal", value: "https://x/y" },
            },
          ],
        },
      ),
    );
    // node "deploy" keeps `deploy`; the tool def yields to `deploy2`.
    expect(out).toContain("const deploy2 = tool.http(");
    expect(out).toContain("const deploy = await deploy2(");
  });
});

// --- bug #2: no `await` inside synchronous arrows ---------------------------

describe("synchronous-arrow hoisting", () => {
  it("hoists a state read out of a stopWhen predicate", () => {
    const out = compileWorkflow(
      graph(
        [
          {
            id: "build",
            type: "agentLoop",
            layout: { x: 1, y: 0 },
            ports: [...inOutPorts],
            config: {
              model: { kind: "literal", value: "m" },
              prompt: { kind: "literal", value: "go" },
              toolIds: [],
              stopCondition: {
                kind: "condition",
                condition: {
                  kind: "compare",
                  op: "gt",
                  left: { kind: "var", name: "threshold" },
                  right: { kind: "literal", value: 5 },
                },
              },
            },
          },
          {
            id: "out",
            type: "output",
            layout: { x: 2, y: 0 },
            ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
            config: { value: { kind: "literal", value: null } },
          },
        ],
        [ctl("e1", "trigger", "build"), ctl("e2", "build", "out")],
        {
          variables: [
            { name: "threshold", scope: "run", dataType: "number", initial: { kind: "literal", value: 0 } },
          ],
        },
      ),
    );
    // the await is hoisted to a const before ai.agent(...)
    expect(out).toContain("const thresholdValue = await threshold.get();");
    expect(out.indexOf("const thresholdValue = await")).toBeLessThan(out.indexOf("ai.agent("));
    // and the predicate arrow itself is await-free
    const predicateLine = out.split("\n").find((l) => l.includes("predicate:"))!;
    expect(predicateLine).toBeDefined();
    expect(predicateLine).not.toContain("await");
    expect(predicateLine).toContain("thresholdValue > 5");
  });
});

// --- v1 scope guards --------------------------------------------------------

describe("unsupported nodes", () => {
  it("throws CompileError for a subworkflow node", () => {
    const g = graph(
      [
        {
          id: "child",
          type: "subworkflow",
          layout: { x: 1, y: 0 },
          ports: [...inOutPorts],
          config: { workflowId: "other", inputs: {} },
        },
        {
          id: "out",
          type: "output",
          layout: { x: 2, y: 0 },
          ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
          config: { value: { kind: "literal", value: null } },
        },
      ],
      [ctl("e1", "trigger", "child"), ctl("e2", "child", "out")],
    );
    expect(() => compileWorkflow(g)).toThrow(CompileError);
  });
});
