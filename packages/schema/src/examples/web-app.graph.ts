// Reference fixture: the "web-application generator" workflow expressed as IR.
//
// The most ambitious of the fixtures, and the one the AI Assistant assembles for
// "Generate a web application". Where landing/content cover the linear + agent-loop
// + fan-out paths, this one is the proof that the IR carries a full self-healing
// build pipeline end to end:
//
//   trigger → draft → IF spec incomplete { clarify } → architect → save plan
//     → PARALLEL.map(feature) { code a feature }          (orchestrator-workers)
//     → LOOP.while(tests failing) { diagnose & fix }       (bounded self-heal)
//     → assemble → deploy preview → APPROVE
//         ├─ approved → deploy production → record → Shipped
//         └─ rejected → Rejected
//
// It is deliberately abstract: the "features" are just items mapped over and the
// heal step is a tool-using agent loop bounded by maxIterations — nothing here is
// specific to any one stack. Swap the prompts/tools and the same skeleton drives
// any spec-to-deploy generation pipeline.
//
// NOTE: lives under src/ so `yarn typecheck` validates it today. Relocate out of
// the published surface before the schema package is cut for npm.

import type { WorkflowGraph } from "../index.js";

export const webAppGraph = {
  id: "wf_web_app_builder",
  name: "Web App Builder",
  version: "1.0.0",
  schemaVersion: 1,

  variables: [
    {
      name: "plan",
      scope: "run",
      dataType: "json",
      initial: { kind: "literal", value: null },
      description: "The architected build plan for the current run.",
    },
    {
      name: "deployments",
      scope: "persistent",
      dataType: "json",
      initial: { kind: "literal", value: [] },
      description: "Deployment ids shipped to production so far.",
    },
  ],

  secrets: [{ name: "DEPLOY_TOKEN", description: "Bearer token for the hosting deploy API." }],

  schemas: {
    AppSpec: {
      type: "object",
      required: ["name", "summary", "features"],
      properties: {
        name: { type: "string" },
        summary: { type: "string" },
        platform: { type: "string" },
        features: { type: "array", items: { type: "string" } },
      },
    },
    RefinedSpec: {
      type: "object",
      required: ["complete", "features"],
      properties: {
        complete: { type: "boolean" },
        openQuestions: { type: "array", items: { type: "string" } },
        features: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
        },
      },
    },
    BuildPlan: {
      type: "object",
      required: ["stack", "features"],
      properties: {
        stack: { type: "string" },
        features: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "detail"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
      },
    },
    FeatureCode: {
      type: "object",
      required: ["featureId", "files"],
      properties: {
        featureId: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "contents"],
            properties: { path: { type: "string" }, contents: { type: "string" } },
          },
        },
      },
    },
    TestReport: {
      type: "object",
      required: ["failures", "summary"],
      properties: { failures: { type: "number" }, summary: { type: "string" } },
    },
    BuildArtifact: {
      type: "object",
      required: ["entryPoint", "bundleUrl"],
      properties: { entryPoint: { type: "string" }, bundleUrl: { type: "string" } },
    },
    DeployResult: {
      type: "object",
      required: ["url", "deploymentId"],
      properties: { url: { type: "string" }, deploymentId: { type: "string" } },
    },
  },

  tools: [
    {
      id: "writeFile",
      name: "Write a source file",
      impl: "fn",
      module: "./app-tools.js",
      exportName: "writeFileHandler",
    },
    {
      id: "runLint",
      name: "Lint the workspace",
      impl: "fn",
      module: "./app-tools.js",
      exportName: "runLintHandler",
    },
    {
      id: "finalizeFeature",
      name: "Finalize a feature",
      impl: "fn",
      module: "./app-tools.js",
      exportName: "finalizeFeatureHandler",
      outputSchema: "FeatureCode",
    },
    {
      id: "runTests",
      name: "Run the test suite",
      impl: "fn",
      module: "./app-tools.js",
      exportName: "runTestsHandler",
      outputSchema: "TestReport",
    },
    {
      id: "editFiles",
      name: "Edit source files",
      impl: "fn",
      module: "./app-tools.js",
      exportName: "editFilesHandler",
    },
    {
      id: "bundleApp",
      name: "Assemble & bundle the app",
      impl: "fn",
      module: "./app-tools.js",
      exportName: "bundleAppHandler",
      outputSchema: "BuildArtifact",
    },
    {
      id: "deploySite",
      name: "Deploy to hosting",
      impl: "http",
      method: { kind: "literal", value: "POST" },
      url: { kind: "literal", value: "https://deploy.internal/api/apps" },
      headers: { "Content-Type": { kind: "literal", value: "application/json" } },
      body: { kind: "var", name: "artifact" },
      auth: { kind: "secret", name: "DEPLOY_TOKEN" },
      inputSchema: "BuildArtifact",
      outputSchema: "DeployResult",
    },
  ],

  nodes: [
    {
      id: "trigger",
      type: "trigger",
      label: "App spec submitted",
      layout: { x: 0, y: 320 },
      ports: [
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "payload",
          kind: "data",
          direction: "out",
          name: "payload",
          dataType: { kind: "schema", schema: "AppSpec" },
        },
      ],
      config: {
        trigger: { kind: "webhook", path: "/hooks/app", method: "POST", inputSchema: "AppSpec" },
      },
    },
    {
      id: "draft",
      type: "llm",
      label: "Draft the spec",
      layout: { x: 240, y: 320 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "RefinedSpec" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You refine a product spec into a concrete, buildable feature list." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Refine the spec for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "name" } },
            { kind: "text", value: ": " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "summary" } },
          ],
        },
        output: { kind: "structured", schema: "RefinedSpec" },
        onError: { kind: "retry", maxAttempts: 2, backoff: { strategy: "fixed", delay: "2s" } },
      },
    },
    {
      id: "specComplete",
      type: "conditional",
      label: "Spec complete?",
      layout: { x: 480, y: 320 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        hasElse: true,
        branches: [
          {
            id: "incomplete",
            name: "Needs clarification",
            condition: {
              kind: "compare",
              op: "eq",
              left: { kind: "ref", nodeId: "draft", path: "complete" },
              right: { kind: "literal", value: false },
            },
          },
        ],
      },
    },
    {
      id: "clarify",
      type: "humanInput",
      label: "Clarify requirements",
      layout: { x: 480, y: 120 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "The spec for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "name" } },
            { kind: "text", value: " has open questions — please clarify." },
          ],
        },
        fields: [
          { id: "answers", name: "Clarifying answers", dataType: "string", required: true },
        ],
      },
    },
    {
      id: "architect",
      type: "llm",
      label: "Architect the app",
      layout: { x: 720, y: 320 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "BuildPlan" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You choose a stack and break the spec into independently buildable features." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Architect a build plan from this refined spec: " },
            { kind: "expr", binding: { kind: "ref", nodeId: "draft" } },
          ],
        },
        output: { kind: "structured", schema: "BuildPlan" },
      },
    },
    {
      id: "savePlan",
      type: "state",
      label: "Save the build plan",
      layout: { x: 960, y: 320 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        variable: "plan",
        operation: "set",
        value: { kind: "ref", nodeId: "architect" },
      },
    },
    {
      id: "buildFeatures",
      type: "parallel",
      label: "Build features",
      layout: { x: 1200, y: 320 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "branch", kind: "control", direction: "out", name: "branch" },
        { id: "join", kind: "control", direction: "in", name: "join" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        mode: "map",
        over: { kind: "ref", nodeId: "architect", path: "features" },
        itemVar: "feature",
        maxConcurrency: 4,
        aggregate: { kind: "merge" },
      },
    },
    {
      id: "codeFeature",
      type: "agentLoop",
      label: "Code a feature",
      layout: { x: 1200, y: 120 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "FeatureCode" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You implement one feature as source files, lint, then finalize." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Implement this feature: " },
            { kind: "expr", binding: { kind: "var", name: "feature" } },
          ],
        },
        toolIds: ["writeFile", "runLint", "finalizeFeature"],
        stopCondition: {
          kind: "any",
          conditions: [{ kind: "toolCalled", toolId: "finalizeFeature" }, { kind: "maxSteps", value: 25 }],
        },
        output: { kind: "structured", schema: "FeatureCode" },
      },
    },
    {
      id: "heal",
      type: "loop",
      label: "Test & self-heal",
      layout: { x: 1440, y: 320 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "body", kind: "control", direction: "out", name: "body" },
        { id: "continue", kind: "control", direction: "in", name: "continue" },
        { id: "done", kind: "control", direction: "out", name: "done" },
      ],
      config: {
        mode: "while",
        condition: {
          kind: "compare",
          op: "gt",
          left: { kind: "ref", nodeId: "healFix", path: "failures" },
          right: { kind: "literal", value: 0 },
        },
        maxIterations: 6,
      },
    },
    {
      id: "healFix",
      type: "agentLoop",
      label: "Diagnose & fix",
      layout: { x: 1440, y: 120 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "TestReport" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You run the tests, diagnose failures, and edit files until the suite is green." },
        prompt: { kind: "template", segments: [{ kind: "text", value: "Run the suite and repair any failures." }] },
        toolIds: ["runTests", "editFiles"],
        stopCondition: {
          kind: "any",
          conditions: [{ kind: "noToolUse" }, { kind: "maxSteps", value: 15 }],
        },
        output: { kind: "structured", schema: "TestReport" },
      },
    },
    {
      id: "assemble",
      type: "tool",
      label: "Assemble & bundle",
      layout: { x: 1680, y: 320 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "BuildArtifact" },
        },
      ],
      config: {
        toolId: "bundleApp",
        args: { plan: { kind: "var", name: "plan" } },
        onError: { kind: "retry", maxAttempts: 2, backoff: { strategy: "fixed", delay: "3s" } },
      },
    },
    {
      id: "deployPreview",
      type: "tool",
      label: "Deploy a preview",
      layout: { x: 1920, y: 320 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "DeployResult" },
        },
      ],
      config: {
        toolId: "deploySite",
        args: {
          artifact: { kind: "ref", nodeId: "assemble" },
          env: { kind: "literal", value: "preview" },
        },
        onError: { kind: "retry", maxAttempts: 3, backoff: { strategy: "exponential", delay: "1s", factor: 2 } },
      },
    },
    {
      id: "review",
      type: "humanApproval",
      label: "Review the preview",
      layout: { x: 2160, y: 320 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Approve the preview for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "name" } },
            { kind: "text", value: "?" },
          ],
        },
        timeout: "48h",
        onTimeout: "escalate",
      },
    },
    {
      id: "deployProd",
      type: "tool",
      label: "Deploy to production",
      layout: { x: 2400, y: 400 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "DeployResult" },
        },
      ],
      config: {
        toolId: "deploySite",
        args: {
          artifact: { kind: "ref", nodeId: "assemble" },
          env: { kind: "literal", value: "production" },
        },
        onError: { kind: "retry", maxAttempts: 3, backoff: { strategy: "exponential", delay: "1s", factor: 2 } },
      },
    },
    {
      id: "recordDeploy",
      type: "state",
      label: "Record the deployment",
      layout: { x: 2640, y: 400 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        variable: "deployments",
        operation: "append",
        value: { kind: "ref", nodeId: "deployProd", path: "deploymentId" },
      },
    },
    {
      id: "shipped",
      type: "output",
      label: "Shipped",
      layout: { x: 2880, y: 400 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "value", kind: "data", direction: "in", name: "value", dataType: "any" },
      ],
      config: { value: { kind: "ref", nodeId: "deployProd" }, schema: "DeployResult" },
    },
    {
      id: "rejected",
      type: "output",
      label: "Rejected",
      layout: { x: 2400, y: 160 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: { value: { kind: "literal", value: { status: "rejected" } } },
    },
  ],

  edges: [
    { id: "e1", kind: "control", from: { nodeId: "trigger", portId: "out" }, to: { nodeId: "draft", portId: "in" } },
    { id: "e2", kind: "control", from: { nodeId: "draft", portId: "out" }, to: { nodeId: "specComplete", portId: "in" } },

    // spec gate: incomplete → clarify (then forward); else → straight to architect.
    { id: "c1", kind: "control", from: { nodeId: "specComplete", portId: "branch:incomplete" }, to: { nodeId: "clarify", portId: "in" } },
    { id: "c2", kind: "control", from: { nodeId: "specComplete", portId: "branch:else" }, to: { nodeId: "architect", portId: "in" } },
    { id: "c3", kind: "control", from: { nodeId: "clarify", portId: "out" }, to: { nodeId: "architect", portId: "in" } },

    { id: "e3", kind: "control", from: { nodeId: "architect", portId: "out" }, to: { nodeId: "savePlan", portId: "in" } },
    { id: "e4", kind: "control", from: { nodeId: "savePlan", portId: "out" }, to: { nodeId: "buildFeatures", portId: "in" } },

    // map fan-out over features → code each → join back.
    { id: "m1", kind: "control", from: { nodeId: "buildFeatures", portId: "branch" }, to: { nodeId: "codeFeature", portId: "in" } },
    { id: "m2", kind: "control", from: { nodeId: "codeFeature", portId: "out" }, to: { nodeId: "buildFeatures", portId: "join" } },

    { id: "e5", kind: "control", from: { nodeId: "buildFeatures", portId: "out" }, to: { nodeId: "heal", portId: "in" } },

    // self-heal loop body + back-edge into "continue"; exit via "done".
    { id: "l1", kind: "control", from: { nodeId: "heal", portId: "body" }, to: { nodeId: "healFix", portId: "in" } },
    { id: "l2", kind: "control", from: { nodeId: "healFix", portId: "out" }, to: { nodeId: "heal", portId: "continue" } },
    { id: "l3", kind: "control", from: { nodeId: "heal", portId: "done" }, to: { nodeId: "assemble", portId: "in" } },

    { id: "e6", kind: "control", from: { nodeId: "assemble", portId: "out" }, to: { nodeId: "deployPreview", portId: "in" } },
    { id: "e7", kind: "control", from: { nodeId: "deployPreview", portId: "out" }, to: { nodeId: "review", portId: "in" } },

    // approval gate: approved → production; rejected → terminal.
    { id: "a1", kind: "control", from: { nodeId: "review", portId: "approved" }, to: { nodeId: "deployProd", portId: "in" } },
    { id: "a2", kind: "control", from: { nodeId: "review", portId: "rejected" }, to: { nodeId: "rejected", portId: "in" } },

    { id: "e8", kind: "control", from: { nodeId: "deployProd", portId: "out" }, to: { nodeId: "recordDeploy", portId: "in" } },
    { id: "e9", kind: "control", from: { nodeId: "recordDeploy", portId: "out" }, to: { nodeId: "shipped", portId: "in" } },
    { id: "d1", kind: "data", from: { nodeId: "deployProd", portId: "result" }, to: { nodeId: "shipped", portId: "value" } },
  ],

  metadata: {
    description: "Refine a spec, clarify if needed, architect, build features in parallel, self-heal the tests, then deploy a preview gated on human approval before shipping to production.",
    tags: ["codegen", "parallel", "loop", "self-heal", "approval", "demo"],
  },
} satisfies WorkflowGraph;
