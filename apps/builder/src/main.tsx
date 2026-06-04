import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FlowBuilder, type AssistantScenario } from "@airun/flow-builder";
import { invoiceGraph, crmAssistantGraph, webAppGraph } from "@airun/schema/examples";
import type { WorkflowGraph } from "@airun/schema";
import "reactflow/dist/style.css";
import "./styles.css";

// Demo harness: the canvas starts empty and the AI Assistant (right sidebar)
// assembles a workflow onto it from a prompt. The reference fixtures are wired in
// as the assistant's scripted scenarios rather than a top-of-app switcher.
const draftGraph: WorkflowGraph = {
  id: "wf_draft",
  name: "Untitled workflow",
  version: "0.1.0",
  schemaVersion: 1,
  nodes: [],
  edges: [],
  variables: [],
  tools: [],
  schemas: {},
  secrets: [],
  metadata: {},
};

const scenarios: ReadonlyArray<AssistantScenario> = [
  {
    id: "crm",
    label: "Build a CRM assistant",
    keywords: ["crm", "sales", "lead", "customer", "pipeline assistant"],
    graph: crmAssistantGraph as WorkflowGraph,
    reply: "Building a CRM assistant — wiring the trigger, routing, and the model steps now.",
    receiptTitle: "Assembled the CRM assistant",
  },
  {
    id: "invoice",
    label: "Automate invoice processing",
    keywords: ["invoice", "billing", "payment", "accounts payable"],
    graph: invoiceGraph as WorkflowGraph,
    reply: "Automating invoice processing — laying down extraction, validation, and approval.",
    receiptTitle: "Assembled the invoice workflow",
  },
  {
    id: "webapp",
    label: "Generate a web application",
    keywords: ["web app", "web application", "app", "build an app", "saas", "full-stack", "website builder"],
    graph: webAppGraph as WorkflowGraph,
    reply:
      "Generating a web application — refining the spec, architecting, building features in parallel, then self-healing the tests before deploy.",
    receiptTitle: "Assembled the web app builder",
  },
];

function App(): ReactElement {
  return (
    <div className="demo-root">
      <div className="demo-canvas">
        <FlowBuilder graph={draftGraph} scenarios={scenarios} />
      </div>
    </div>
  );
}

const el = document.getElementById("root");
if (!el) throw new Error("Missing #root element.");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
