// Reference fixture: the "landing-page builder" workflow expressed as IR.
//
// A second, richer twin to invoice.graph.ts. Where invoice exercises the linear
// + conditional + approval path, this one covers the agent loop (a tool-using
// builder agent with a stop condition), fn-tools (imported handlers), structured
// LLM output, human approval, an HTTP deploy tool and persistent state.
//
// NOTE: lives under src/ so `yarn typecheck` validates it today. Relocate out of
// the published surface before the schema package is cut for npm.

import type { WorkflowGraph } from "../index.js";

export const landingGraph = {
  id: "wf_landing_builder",
  name: "Landing Page Builder",
  version: "1.0.0",
  schemaVersion: 1,

  variables: [
    {
      name: "deployments",
      scope: "persistent",
      dataType: "json",
      initial: { kind: "literal", value: [] },
      description: "Deployment ids shipped so far.",
    },
  ],

  secrets: [{ name: "DEPLOY_TOKEN", description: "Bearer token for the static-hosting deploy API." }],

  schemas: {
    BriefPayload: {
      type: "object",
      required: ["productName", "description", "audience"],
      properties: {
        productName: { type: "string" },
        tagline: { type: "string" },
        description: { type: "string" },
        audience: { type: "string" },
        brandColor: { type: "string" },
      },
    },
    SitePlan: {
      type: "object",
      required: ["title", "sections"],
      properties: {
        title: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            required: ["heading", "body"],
            properties: {
              heading: { type: "string" },
              body: { type: "string" },
              cta: { type: "string" },
            },
          },
        },
      },
    },
    BuildResult: {
      type: "object",
      required: ["entryPoint", "files"],
      properties: {
        entryPoint: { type: "string" },
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
    DeployResult: {
      type: "object",
      required: ["url", "deploymentId"],
      properties: { url: { type: "string" }, deploymentId: { type: "string" } },
    },
  },

  tools: [
    {
      id: "writeComponent",
      name: "Write a site component",
      impl: "fn",
      module: "./site-tools.js",
      exportName: "writeComponentHandler",
      inputSchema: "SitePlan",
    },
    {
      id: "lintCheck",
      name: "Lint the generated site",
      impl: "fn",
      module: "./site-tools.js",
      exportName: "lintCheckHandler",
    },
    {
      id: "finalizeSite",
      name: "Finalize the build",
      impl: "fn",
      module: "./site-tools.js",
      exportName: "finalizeSiteHandler",
      outputSchema: "BuildResult",
    },
    {
      id: "deploySite",
      name: "Deploy to hosting",
      impl: "http",
      method: { kind: "literal", value: "POST" },
      url: { kind: "literal", value: "https://deploy.internal/api/sites" },
      headers: { "Content-Type": { kind: "literal", value: "application/json" } },
      body: { kind: "var", name: "site" },
      auth: { kind: "secret", name: "DEPLOY_TOKEN" },
      inputSchema: "BuildResult",
      outputSchema: "DeployResult",
    },
  ],

  nodes: [
    {
      id: "trigger",
      type: "trigger",
      label: "Brief submitted",
      layout: { x: 0, y: 200 },
      ports: [
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "payload",
          kind: "data",
          direction: "out",
          name: "payload",
          dataType: { kind: "schema", schema: "BriefPayload" },
        },
      ],
      config: {
        trigger: { kind: "webhook", path: "/hooks/landing", method: "POST", inputSchema: "BriefPayload" },
      },
    },
    {
      id: "plan",
      type: "llm",
      label: "Plan the page",
      layout: { x: 240, y: 200 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "SitePlan" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You are a senior landing-page designer." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Draft a landing page for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "productName" } },
            { kind: "text", value: " aimed at " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "audience" } },
            { kind: "text", value: ". Pitch: " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "description" } },
          ],
        },
        output: { kind: "structured", schema: "SitePlan" },
        onError: { kind: "retry", maxAttempts: 2, backoff: { strategy: "fixed", delay: "2s" } },
      },
    },
    {
      id: "build",
      type: "agentLoop",
      label: "Build the site",
      layout: { x: 480, y: 200 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "BuildResult" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You implement the planned page as static files, then finalize." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Implement this plan: " },
            { kind: "expr", binding: { kind: "ref", nodeId: "plan" } },
          ],
        },
        toolIds: ["writeComponent", "lintCheck", "finalizeSite"],
        stopCondition: {
          kind: "any",
          conditions: [{ kind: "toolCalled", toolId: "finalizeSite" }, { kind: "maxSteps", value: 20 }],
        },
        output: { kind: "structured", schema: "BuildResult" },
      },
    },
    {
      id: "review",
      type: "humanApproval",
      label: "Review the page",
      layout: { x: 720, y: 200 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Approve the landing page for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "productName" } },
            { kind: "text", value: "?" },
          ],
        },
        timeout: "48h",
        onTimeout: "escalate",
      },
    },
    {
      id: "deploy",
      type: "tool",
      label: "Deploy",
      layout: { x: 960, y: 280 },
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
        args: { site: { kind: "ref", nodeId: "build" } },
        onError: {
          kind: "retry",
          maxAttempts: 3,
          backoff: { strategy: "exponential", delay: "1s", factor: 2 },
        },
      },
    },
    {
      id: "recordDeploy",
      type: "state",
      label: "Record deployment",
      layout: { x: 1200, y: 280 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        variable: "deployments",
        operation: "append",
        value: { kind: "ref", nodeId: "deploy", path: "deploymentId" },
      },
    },
    {
      id: "out",
      type: "output",
      label: "Deployed",
      layout: { x: 1440, y: 280 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "value", kind: "data", direction: "in", name: "value", dataType: "any" },
      ],
      config: { value: { kind: "ref", nodeId: "deploy" }, schema: "DeployResult" },
    },
    {
      id: "rejectedOut",
      type: "output",
      label: "Rejected",
      layout: { x: 960, y: 60 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: { value: { kind: "literal", value: { status: "rejected" } } },
    },
  ],

  edges: [
    { id: "e1", kind: "control", from: { nodeId: "trigger", portId: "out" }, to: { nodeId: "plan", portId: "in" } },
    { id: "e2", kind: "control", from: { nodeId: "plan", portId: "out" }, to: { nodeId: "build", portId: "in" } },
    { id: "e3", kind: "control", from: { nodeId: "build", portId: "out" }, to: { nodeId: "review", portId: "in" } },
    { id: "e4", kind: "control", from: { nodeId: "review", portId: "approved" }, to: { nodeId: "deploy", portId: "in" } },
    { id: "e5", kind: "control", from: { nodeId: "review", portId: "rejected" }, to: { nodeId: "rejectedOut", portId: "in" } },
    { id: "e6", kind: "control", from: { nodeId: "deploy", portId: "out" }, to: { nodeId: "recordDeploy", portId: "in" } },
    { id: "e7", kind: "control", from: { nodeId: "recordDeploy", portId: "out" }, to: { nodeId: "out", portId: "in" } },
    { id: "d1", kind: "data", from: { nodeId: "deploy", portId: "result" }, to: { nodeId: "out", portId: "value" } },
  ],

  metadata: {
    description: "Turn a product brief into a deployed landing page, gated on human review.",
    tags: ["marketing", "codegen", "approval", "demo"],
  },
} satisfies WorkflowGraph;
