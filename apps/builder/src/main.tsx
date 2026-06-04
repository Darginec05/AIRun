import { StrictMode, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FlowBuilder } from "@airun/flow-builder";
import {
  invoiceGraph,
  landingGraph,
  contentPipelineGraph,
  crmAssistantGraph,
} from "@airun/schema/examples";
import type { WorkflowGraph } from "@airun/schema";
import "reactflow/dist/style.css";
import "./styles.css";

// Demo harness: every reference fixture from @airun/schema/examples, switchable
// so we can flip through them and exercise the canvas + live codegen. The graphs
// live in the schema package; this app only picks which one to mount.
const examples: ReadonlyArray<{ key: string; label: string; graph: WorkflowGraph }> = [
  { key: "invoice", label: "Invoice", graph: invoiceGraph as WorkflowGraph },
  { key: "landing", label: "Landing", graph: landingGraph as WorkflowGraph },
  { key: "content", label: "Content pipeline", graph: contentPipelineGraph as WorkflowGraph },
  { key: "crm", label: "CRM assistant", graph: crmAssistantGraph as WorkflowGraph },
];

function App(): ReactElement {
  const [selected, setSelected] = useState(examples[0]!.key);
  const active = examples.find((e) => e.key === selected) ?? examples[0]!;

  return (
    <div className="demo-root">
      <div className="demo-bar">
        <span className="demo-bar-label">Example</span>
        <div className="demo-tabs">
          {examples.map((e) => (
            <button
              key={e.key}
              type="button"
              className={`demo-tab${e.key === selected ? " is-active" : ""}`}
              onClick={() => setSelected(e.key)}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>
      {/* key forces a fresh mount so the canvas resets to the new graph. */}
      <div className="demo-canvas">
        <FlowBuilder key={active.key} graph={active.graph} />
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
