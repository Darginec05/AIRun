// Reference fixture: the "invoice-processing" workflow expressed as IR.
//
// This is the contract verified "from the editor end": a hand-authored
// WorkflowGraph that must typecheck against the v1 IR (`satisfies WorkflowGraph`).
// Its twin is packages/sdk/src/examples/invoice.workflow.ts — the same workflow
// expressed on the SDK surface, the "developer end". The compiler turns one into
// the other; keeping both in the repo keeps the two ends honest.
//
// NOTE: lives under src/ so `yarn typecheck` validates it today. Relocate out of
// the published surface before the schema package is cut for npm.

import type { WorkflowGraph } from "../index.js";

export const invoiceGraph = {
  id: "wf_invoice_processing",
  name: "Invoice Processing",
  version: "1.0.0",
  schemaVersion: 1,

  variables: [
    {
      name: "processed",
      scope: "persistent",
      dataType: "json",
      initial: { kind: "literal", value: [] },
      description: "Ids of invoices already posted to the ledger.",
    },
  ],

  secrets: [{ name: "LEDGER_API_KEY", description: "Bearer token for the ledger API." }],

  schemas: {
    InvoicePayload: {
      type: "object",
      required: ["invoiceId", "vendor", "amount", "currency", "fileUrl"],
      properties: {
        invoiceId: { type: "string" },
        vendor: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string" },
        fileUrl: { type: "string" },
      },
    },
    InvoiceData: {
      type: "object",
      required: ["total", "lineItems"],
      properties: {
        total: { type: "number" },
        dueDate: { type: "string" },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: { description: { type: "string" }, amount: { type: "number" } },
          },
        },
      },
    },
    LedgerResult: {
      type: "object",
      required: ["entryId"],
      properties: { entryId: { type: "string" }, status: { type: "string" } },
    },
  },

  tools: [
    {
      id: "postLedger",
      name: "Post to ledger",
      impl: "http",
      method: { kind: "literal", value: "POST" },
      url: { kind: "literal", value: "https://ledger.internal/api/entries" },
      headers: {
        "Content-Type": { kind: "literal", value: "application/json" },
      },
      body: { kind: "var", name: "data" }, // resolves to ToolNode.args.data
      auth: { kind: "secret", name: "LEDGER_API_KEY" },
      inputSchema: "InvoiceData",
      outputSchema: "LedgerResult",
    },
  ],

  nodes: [
    {
      id: "trigger",
      type: "trigger",
      label: "Invoice received",
      layout: { x: 0, y: 160 },
      ports: [
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "payload",
          kind: "data",
          direction: "out",
          name: "payload",
          dataType: { kind: "schema", schema: "InvoicePayload" },
        },
      ],
      config: {
        trigger: {
          kind: "webhook",
          path: "/hooks/invoice",
          method: "POST",
          inputSchema: "InvoicePayload",
        },
      },
    },
    {
      id: "extract",
      type: "llm",
      label: "Extract invoice data",
      layout: { x: 240, y: 160 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "InvoiceData" },
        },
      ],
      config: {
        model: { kind: "literal", value: "claude-sonnet-4-6" },
        systemPrompt: { kind: "static", text: "You extract structured data from invoices." },
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Extract line items and totals from the invoice at " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "fileUrl" } },
          ],
        },
        output: { kind: "structured", schema: "InvoiceData" },
        onError: { kind: "retry", maxAttempts: 2, backoff: { strategy: "fixed", delay: "2s" } },
      },
    },
    {
      id: "needsApproval",
      type: "conditional",
      label: "Needs approval?",
      layout: { x: 480, y: 160 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        hasElse: true,
        branches: [
          {
            id: "high",
            name: "Amount over 1000",
            condition: {
              kind: "compare",
              op: "gt",
              left: { kind: "ref", nodeId: "trigger", path: "amount" },
              right: { kind: "literal", value: 1000 },
            },
          },
        ],
      },
    },
    {
      id: "approve",
      type: "humanApproval",
      label: "Manager approval",
      layout: { x: 720, y: 80 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        prompt: {
          kind: "template",
          segments: [
            { kind: "text", value: "Approve invoice " },
            { kind: "expr", binding: { kind: "ref", nodeId: "trigger", path: "invoiceId" } },
            { kind: "text", value: "?" },
          ],
        },
        timeout: "24h",
        onTimeout: "reject",
      },
    },
    {
      id: "postToLedger",
      type: "tool",
      label: "Post to ledger",
      layout: { x: 960, y: 160 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
        {
          id: "result",
          kind: "data",
          direction: "out",
          name: "result",
          dataType: { kind: "schema", schema: "LedgerResult" },
        },
      ],
      config: {
        toolId: "postLedger",
        args: {
          data: { kind: "ref", nodeId: "extract" },
        },
        onError: {
          kind: "retry",
          maxAttempts: 3,
          backoff: { strategy: "exponential", delay: "1s", factor: 2 },
          then: { kind: "route" },
        },
      },
    },
    {
      id: "recordProcessed",
      type: "state",
      label: "Record processed",
      layout: { x: 1200, y: 160 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "out", kind: "control", direction: "out", name: "out" },
      ],
      config: {
        variable: "processed",
        operation: "append",
        value: { kind: "ref", nodeId: "trigger", path: "invoiceId" },
      },
    },
    {
      id: "out",
      type: "output",
      label: "Result",
      layout: { x: 1440, y: 160 },
      ports: [
        { id: "in", kind: "control", direction: "in", name: "in" },
        { id: "value", kind: "data", direction: "in", name: "value", dataType: "any" },
      ],
      config: {
        value: { kind: "ref", nodeId: "postToLedger" },
        schema: "LedgerResult",
      },
    },
    {
      id: "rejectedOut",
      type: "output",
      label: "Rejected",
      layout: { x: 960, y: 0 },
      ports: [{ id: "in", kind: "control", direction: "in", name: "in" }],
      config: {
        value: { kind: "literal", value: { status: "rejected" } },
      },
    },
  ],

  edges: [
    { id: "e1", kind: "control", from: { nodeId: "trigger", portId: "out" }, to: { nodeId: "extract", portId: "in" } },
    { id: "e2", kind: "control", from: { nodeId: "extract", portId: "out" }, to: { nodeId: "needsApproval", portId: "in" } },
    { id: "e3", kind: "control", from: { nodeId: "needsApproval", portId: "branch:high" }, to: { nodeId: "approve", portId: "in" } },
    { id: "e4", kind: "control", from: { nodeId: "needsApproval", portId: "branch:else" }, to: { nodeId: "postToLedger", portId: "in" } },
    { id: "e5", kind: "control", from: { nodeId: "approve", portId: "approved" }, to: { nodeId: "postToLedger", portId: "in" } },
    { id: "e6", kind: "control", from: { nodeId: "approve", portId: "rejected" }, to: { nodeId: "rejectedOut", portId: "in" } },
    { id: "e7", kind: "control", from: { nodeId: "postToLedger", portId: "out" }, to: { nodeId: "recordProcessed", portId: "in" } },
    { id: "e8", kind: "control", from: { nodeId: "recordProcessed", portId: "out" }, to: { nodeId: "out", portId: "in" } },
    { id: "d1", kind: "data", from: { nodeId: "postToLedger", portId: "result" }, to: { nodeId: "out", portId: "value" } },
  ],

  metadata: {
    description: "Parse an incoming invoice, gate large amounts on human approval, post to the ledger.",
    tags: ["finance", "approval", "demo"],
  },
} satisfies WorkflowGraph;
