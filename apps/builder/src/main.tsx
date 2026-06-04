import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FlowBuilder } from "@airun/flow-builder";
import { invoiceGraph } from "@airun/schema/examples";
import type { WorkflowGraph } from "@airun/schema";
import "reactflow/dist/style.css";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("Missing #root element.");

createRoot(el).render(
  <StrictMode>
    <FlowBuilder graph={invoiceGraph as WorkflowGraph} />
  </StrictMode>,
);
