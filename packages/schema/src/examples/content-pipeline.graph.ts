// Reference fixture: a durable "content pipeline" workflow expressed as IR.
//
// Modelled on a real production content/landing-page generator (tapflow): a
// linear chain with one fan-out and a per-item loop. Where invoice/landing
// exercise the sequential + approval + agent-loop paths, this one is the proof
// that the IR expresses the workflow-native shape end to end:
//
//   ground → analyze → core → PARALLEL[ landing ∥ pricing ∥ pageList ]
//                                    → forEach(page) { write → record } → assemble
//
// It is deliberately abstract: the "sections" are just parallel LLM branches and
// the per-page step is a forEach loop — nothing here is specific to landing
// pages. Swap the prompts/schemas and the same skeleton drives any multi-section
// generation pipeline.
//
// NOTE: lives under src/ so `yarn typecheck` validates it today. Relocate out of
// the published surface before the schema package is cut for npm.

import type { WorkflowGraph } from "../index.js";

export const contentPipelineGraph = {
  id: "wf_content_pipeline",
  name: "Content Pipeline",
  version: "1.0.0",
  schemaVersion: 1,

  variables: [
    {
      name: "pages",
      scope: "run",
      dataType: "json",
      initial: { kind: "literal", value: [] },
      description: "Per-page content collected during the forEach loop.",
    },
  ],

  secrets: [{ name: "CONTENT_API_KEY", description: "Bearer token for the source-grounding service." }],

  schemas: {
    BriefPayload: {
      type: "object",
      required: ["productName", "audience", "description", "sources"],
      properties: {
        productName: { type: "string" },
        audience: { type: "string" },
        description: { type: "string" },
        sources: { type: "array", items: { type: "string" } },
      },
    },
    Corpus: {
      type: "object",
      required: ["text", "sourceCount"],
      properties: { text: { type: "string" }, sourceCount: { type: "number" } },
    },
    Analysis: {
      type: "object",
      required: ["language", "tone"],
      properties: {
        language: { type: "string" },
        tone: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
      },
    },
    CoreContent: {
      type: "object",
      required: ["title", "summary"],
      properties: { title: { type: "string" }, summary: { type: "string" } },
    },
    LandingContent: {
      type: "object",
      required: ["hero", "sections"],
      properties: { hero: { type: "string" }, sections: { type: "array", items: { type: "string" } } },
    },
    PricingContent: {
      type: "object",
      required: ["plans"],
      properties: {
        plans: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "price"],
            properties: { name: { type: "string" }, price: { type: "string" } },
          },
        },
      },
    },
    PageList: {
      type: "object",
      required: ["pages"],
      properties: {
        pages: {
          type: "array",
          items: {
            type: "object",
            required: ["slug", "title"],
            properties: { slug: { type: "string" }, title: { type: "string" } },
          },
        },
      },
    },
    PageContent: {
      type: "object",
      required: ["slug", "body"],
      properties: { slug: { type: "string" }, body: { type: "string" } },
    },
    SiteBundle: {
      type: "object",
      required: ["title", "landing", "pricing", "pages"],
      properties: {
        title: { type: "string" },
        landing: { type: "object" },
        pricing: { type: "object" },
        pages: { type: "array" },
      },
    },
  },

  tools: [
    {
      id: "groundSources",
      name: "Ground the source material",
      impl: "http",
      method: { kind: "literal", value: "POST" },
      url: { kind: "literal", value: "https://content.internal/api/ground" },
      headers: { "Content-Type": { kind: "literal", value: "application/json" } },
      body: { kind: "var", name: "sources" },
      auth: { kind: "secret", name: "CONTENT_API_KEY" },
      outputSchema: "Corpus",
    },
  ],

  nodes: [
    {
      id: "trigger",
      type: "trigger",
      label: "Brief submitted",
      layout: { x: 0, y: 240 },
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
        trigger: { kind: "webhook", path: "/hooks/content", method: "POST", inputSchema: "BriefPayload" },
      },
    },
    {
      id: "ground",
      type: "tool",
      label: "Ground sources",
      layout: { x: 240, y: 240 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "Corpus" },
        },
      ],
      config: {
        toolId: "groundSources",
        args: { sources: { kind: "ref", nodeId: "trigger", path: "sources" } },
        onError: { kind: "retry", maxAttempts: 3, backoff: { strategy: "exponential", delay: "1s", factor: 2 } },
      },
    },
    {
      id: "analyze",
      type: "llm",
      label: "Analyze corpus",
      layout: { x: 480, y: 240 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "Analysis" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You analyze source material for tone and language." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Analyze this corpus: " },
            { kind: "expr", binding: { kind: "ref", nodeId: "ground", path: "text" } },
          ],
        },
        output: { kind: "structured", schema: "Analysis" },
        onError: { kind: "retry", maxAttempts: 2, backoff: { strategy: "fixed", delay: "2s" } },
      },
    },
    {
      id: "core",
      type: "llm",
      label: "Draft core content",
      layout: { x: 720, y: 240 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "CoreContent" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You write the core title and summary." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Write a title and summary for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "productName" } },
            { kind: "text", value: " in tone " },
            { kind: "expr", binding: { kind: "ref", nodeId: "analyze", path: "tone" } },
          ],
        },
        output: { kind: "structured", schema: "CoreContent" },
      },
    },
    {
      id: "compose",
      type: "parallel",
      label: "Compose sections",
      layout: { x: 960, y: 240 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        mode: "branches",
        aggregate: { kind: "object", keys: ["landing", "pricing", "pageList"] },
      },
    },
    {
      id: "landing",
      type: "llm",
      label: "Landing section",
      layout: { x: 1200, y: 80 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "LandingContent" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You write the landing hero and sections." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Write a landing section from this summary: " },
            { kind: "expr", binding: { kind: "ref", nodeId: "core", path: "summary" } },
          ],
        },
        output: { kind: "structured", schema: "LandingContent" },
      },
    },
    {
      id: "pricing",
      type: "llm",
      label: "Pricing section",
      layout: { x: 1200, y: 240 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "PricingContent" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You design pricing plans." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Propose pricing plans for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "audience" } },
          ],
        },
        output: { kind: "structured", schema: "PricingContent" },
      },
    },
    {
      id: "pageList",
      type: "llm",
      label: "Plan pages",
      layout: { x: 1200, y: 400 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "PageList" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You plan the list of pages the site needs." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "List the pages needed for " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "productName" } },
          ],
        },
        output: { kind: "structured", schema: "PageList" },
      },
    },
    {
      id: "perPage",
      type: "loop",
      label: "Write each page",
      layout: { x: 1440, y: 240 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        mode: "forEach",
        collection: { kind: "ref", nodeId: "compose", path: "pageList.pages" },
        itemVar: "page",
        maxIterations: 50,
      },
    },
    {
      id: "writePage",
      type: "llm",
      label: "Write page",
      layout: { x: 1680, y: 160 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "PageContent" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You write the body for one page." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Write the page titled " },
            { kind: "expr", binding: { kind: "var", name: "page" } },
          ],
        },
        output: { kind: "structured", schema: "PageContent" },
      },
    },
    {
      id: "recordPage",
      type: "state",
      label: "Record page",
      layout: { x: 1920, y: 160 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        variable: "pages",
        operation: "append",
        value: { kind: "ref", nodeId: "writePage" },
      },
    },
    {
      id: "assemble",
      type: "transform",
      label: "Assemble bundle",
      layout: { x: 1680, y: 400 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        input: { kind: "ref", nodeId: "core" },
        transform: {
          kind: "map",
          mapping: {
            title: { kind: "ref", nodeId: "core", path: "title" },
            landing: { kind: "ref", nodeId: "compose", path: "landing" },
            pricing: { kind: "ref", nodeId: "compose", path: "pricing" },
            pages: { kind: "var", name: "pages" },
          },
        },
      },
    },
    {
      id: "out",
      type: "output",
      label: "Site bundle",
      layout: { x: 1920, y: 400 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: { value: { kind: "ref", nodeId: "assemble" }, schema: "SiteBundle" },
    },
  ],

  edges: [
    { id: "e1", kind: "control", from: { nodeId: "trigger", portId: "out" }, to: { nodeId: "ground", portId: "in" } },
    { id: "e2", kind: "control", from: { nodeId: "ground", portId: "out" }, to: { nodeId: "analyze", portId: "in" } },
    { id: "e3", kind: "control", from: { nodeId: "analyze", portId: "out" }, to: { nodeId: "core", portId: "in" } },
    { id: "e4", kind: "control", from: { nodeId: "core", portId: "out" }, to: { nodeId: "compose", portId: "in" } },

    // fan-out: one "branch" out-port → three concurrent branches, joined back.
    { id: "b1", kind: "control", from: { nodeId: "compose", portId: "branch" }, to: { nodeId: "landing", portId: "in" } },
    { id: "b2", kind: "control", from: { nodeId: "compose", portId: "branch" }, to: { nodeId: "pricing", portId: "in" } },
    { id: "b3", kind: "control", from: { nodeId: "compose", portId: "branch" }, to: { nodeId: "pageList", portId: "in" } },
    { id: "j1", kind: "control", from: { nodeId: "landing", portId: "out" }, to: { nodeId: "compose", portId: "join" } },
    { id: "j2", kind: "control", from: { nodeId: "pricing", portId: "out" }, to: { nodeId: "compose", portId: "join" } },
    { id: "j3", kind: "control", from: { nodeId: "pageList", portId: "out" }, to: { nodeId: "compose", portId: "join" } },

    { id: "e5", kind: "control", from: { nodeId: "compose", portId: "out" }, to: { nodeId: "perPage", portId: "in" } },

    // loop body + back-edge into "continue"; exit via "done".
    { id: "l1", kind: "control", from: { nodeId: "perPage", portId: "body" }, to: { nodeId: "writePage", portId: "in" } },
    { id: "l2", kind: "control", from: { nodeId: "writePage", portId: "out" }, to: { nodeId: "recordPage", portId: "in" } },
    { id: "l3", kind: "control", from: { nodeId: "recordPage", portId: "out" }, to: { nodeId: "perPage", portId: "continue" } },
    { id: "l4", kind: "control", from: { nodeId: "perPage", portId: "done" }, to: { nodeId: "assemble", portId: "in" } },

    { id: "e6", kind: "control", from: { nodeId: "assemble", portId: "out" }, to: { nodeId: "out", portId: "in" } },
  ],

  metadata: {
    description: "Ground sources, analyze, draft core content, fan out section generation, write each page in a loop, then assemble the bundle.",
    tags: ["content", "parallel", "loop", "pipeline", "demo"],
  },
} satisfies WorkflowGraph;
