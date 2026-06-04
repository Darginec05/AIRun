// Reference fixture: a conversational "CRM assistant" workflow expressed as IR.
//
// Modelled on a real production chat agent (airun): an inbound message is
// classified, then routed to one of three handlers. The "manage records" route
// is the interesting one — it runs a tool-using agent loop, then gates the
// proposed write behind human approval before applying it. This is the boundary
// case for the IR: the conversational shell lives outside the graph (the model
// decides tool calls inside `agentLoop`), but the *routing* and the
// human-in-the-loop write gate are workflow-shaped and compile today.
//
// Abstract on purpose: "classify → route → (agent + approval + write)" is a
// generic pattern. Nothing here is CRM-specific beyond the prompts/tool names.
//
// NOTE: lives under src/ so `yarn typecheck` validates it today. Relocate out of
// the published surface before the schema package is cut for npm.

import type { WorkflowGraph } from "../index.js";

export const crmAssistantGraph = {
  id: "wf_crm_assistant",
  name: "CRM Assistant",
  version: "1.0.0",
  schemaVersion: 1,

  variables: [],

  secrets: [{ name: "CRM_TOKEN", description: "Bearer token for the CRM write API." }],

  schemas: {
    UserMessage: {
      type: "object",
      required: ["text", "workspaceId"],
      properties: { text: { type: "string" }, workspaceId: { type: "string" } },
    },
    AssistResult: {
      type: "object",
      required: ["summary", "proposedChange"],
      properties: {
        summary: { type: "string" },
        proposedChange: {
          type: "object",
          required: ["unitId", "patch"],
          properties: { unitId: { type: "string" }, patch: { type: "object" } },
        },
      },
    },
    UpdateResult: {
      type: "object",
      required: ["unitId", "status"],
      properties: { unitId: { type: "string" }, status: { type: "string" } },
    },
  },

  tools: [
    {
      id: "searchUnits",
      name: "Search units",
      impl: "fn",
      module: "./crm-tools.js",
      exportName: "searchUnitsHandler",
    },
    {
      id: "updateUnit",
      name: "Update a unit",
      impl: "http",
      method: { kind: "literal", value: "PATCH" },
      url: { kind: "literal", value: "https://crm.internal/api/units" },
      headers: { "Content-Type": { kind: "literal", value: "application/json" } },
      body: { kind: "var", name: "patch" },
      auth: { kind: "secret", name: "CRM_TOKEN" },
      outputSchema: "UpdateResult",
    },
  ],

  nodes: [
    {
      id: "trigger",
      type: "trigger",
      label: "Message received",
      layout: { x: 0, y: 240 },
      ports: [
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "payload",
          kind: "data",
          direction: "out",
          name: "payload",
          dataType: { kind: "schema", schema: "UserMessage" },
        },
      ],
      config: {
        trigger: { kind: "webhook", path: "/hooks/assistant", method: "POST", inputSchema: "UserMessage" },
      },
    },
    {
      id: "route",
      type: "router",
      label: "Classify intent",
      layout: { x: 240, y: 240 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        input: { kind: "ref", nodeId: "trigger", path: "text" },
        mode: "classify",
        model: { kind: "literal", value: "claude-haiku-4-5-20251001" },
        routes: [
          { id: "manage", name: "Manage records", description: "Search, edit or update CRM records." },
          { id: "website", name: "Generate website", description: "Generate marketing/site content." },
          { id: "smalltalk", name: "Small talk", description: "Greetings and chit-chat." },
        ],
        fallbackRouteId: "smalltalk",
      },
    },

    // --- manage route: agent → approval → write ------------------------------
    {
      id: "assist",
      type: "agentLoop",
      label: "Assist with records",
      layout: { x: 480, y: 80 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "AssistResult" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You help manage CRM records. Search before proposing a change." },
        prompt: { kind: "ref", nodeId: "trigger", path: "text" },
        toolIds: ["searchUnits"],
        stopCondition: {
          kind: "any",
          conditions: [{ kind: "noToolUse" }, { kind: "maxSteps", value: 8 }],
        },
        output: { kind: "structured", schema: "AssistResult" },
      },
    },
    {
      id: "approve",
      type: "humanApproval",
      label: "Approve change",
      layout: { x: 720, y: 80 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Apply this change? " },
            { kind: "expr", binding: { kind: "ref", nodeId: "assist", path: "summary" } },
          ],
        },
        timeout: "12h",
        onTimeout: "reject",
      },
    },
    {
      id: "applyChange",
      type: "tool",
      label: "Apply change",
      layout: { x: 960, y: 40 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "UpdateResult" },
        },
      ],
      config: {
        toolId: "updateUnit",
        args: { patch: { kind: "ref", nodeId: "assist", path: "proposedChange" } },
        onError: { kind: "retry", maxAttempts: 2, backoff: { strategy: "fixed", delay: "1s" } },
      },
    },
    {
      id: "manageOut",
      type: "output",
      label: "Applied",
      layout: { x: 1200, y: 40 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: { value: { kind: "ref", nodeId: "applyChange" }, schema: "UpdateResult" },
    },
    {
      id: "rejectedOut",
      type: "output",
      label: "Rejected",
      layout: { x: 960, y: 160 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: { value: { kind: "literal", value: { status: "rejected" } } },
    },

    // --- website route -------------------------------------------------------
    {
      id: "site",
      type: "llm",
      label: "Generate site copy",
      layout: { x: 480, y: 280 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        { id: "result", kind: "data", direction: "out", name: "result", dataType: "string" },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You generate marketing copy." },
        prompt: { kind: "ref", nodeId: "trigger", path: "text" },
        output: { kind: "text" },
      },
    },
    {
      id: "websiteOut",
      type: "output",
      label: "Site copy",
      layout: { x: 720, y: 280 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: { value: { kind: "ref", nodeId: "site" } },
    },

    // --- smalltalk route -----------------------------------------------------
    {
      id: "chat",
      type: "llm",
      label: "Chit-chat reply",
      layout: { x: 480, y: 440 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        { id: "result", kind: "data", direction: "out", name: "result", dataType: "string" },
      ],
      config: {
        model: { kind: "literal", value: "claude-haiku-4-5-20251001" },
        systemPrompt: { kind: "static", text: "You are a friendly assistant." },
        prompt: { kind: "ref", nodeId: "trigger", path: "text" },
        output: { kind: "text" },
      },
    },
    {
      id: "chatOut",
      type: "output",
      label: "Reply",
      layout: { x: 720, y: 440 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: { value: { kind: "ref", nodeId: "chat" } },
    },
  ],

  edges: [
    { id: "e1", kind: "control", from: { nodeId: "trigger", portId: "out" }, to: { nodeId: "route", portId: "in" } },

    { id: "r1", kind: "control", from: { nodeId: "route", portId: "route:manage" }, to: { nodeId: "assist", portId: "in" } },
    { id: "r2", kind: "control", from: { nodeId: "route", portId: "route:website" }, to: { nodeId: "site", portId: "in" } },
    { id: "r3", kind: "control", from: { nodeId: "route", portId: "route:smalltalk" }, to: { nodeId: "chat", portId: "in" } },

    { id: "m1", kind: "control", from: { nodeId: "assist", portId: "out" }, to: { nodeId: "approve", portId: "in" } },
    { id: "m2", kind: "control", from: { nodeId: "approve", portId: "approved" }, to: { nodeId: "applyChange", portId: "in" } },
    { id: "m3", kind: "control", from: { nodeId: "approve", portId: "rejected" }, to: { nodeId: "rejectedOut", portId: "in" } },
    { id: "m4", kind: "control", from: { nodeId: "applyChange", portId: "out" }, to: { nodeId: "manageOut", portId: "in" } },

    { id: "w1", kind: "control", from: { nodeId: "site", portId: "out" }, to: { nodeId: "websiteOut", portId: "in" } },
    { id: "s1", kind: "control", from: { nodeId: "chat", portId: "out" }, to: { nodeId: "chatOut", portId: "in" } },
  ],

  metadata: {
    description: "Classify an inbound message, then route to an agent-loop record assistant (with a human-approved write gate), a site-copy generator, or a small-talk reply.",
    tags: ["assistant", "router", "agent", "approval", "demo"],
  },
} satisfies WorkflowGraph;
