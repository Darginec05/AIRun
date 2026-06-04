// @airun/flow-builder — the embeddable visual builder (React).
//
// One <FlowBuilder /> component bundling the three zones + code drawer: palette,
// React Flow canvas (customized for the two-edge control/data contract and
// valid-target highlighting), inspector forms, and the live workflow.ts /
// workflow.graph.json / @airun/sdk drawer. Emits a WorkflowGraph; never owns
// runtime.
//
// Consumers must include React Flow's base stylesheet (`reactflow/dist/style.css`)
// and the builder stylesheet that defines the design tokens + `wf-*` classes.

export { FlowBuilder } from "./flow-builder.js";
export type { FlowBuilderProps } from "./flow-builder.js";

export { graphToFlow, dataTypeLabel } from "./graph-adapter.js";
export type { FlowModel } from "./graph-adapter.js";

export { WorkflowNodeCard } from "./nodes.js";
export type { WorkflowNodeData } from "./nodes.js";

export { ControlEdge, DataEdge } from "./edges.js";
export type { DataEdgeData } from "./edges.js";

export { Palette } from "./palette.js";
export { Inspector } from "./inspector.js";
export type { BindingContext, InspectorProps, InspectorShellProps } from "./inspector.js";
export { Icon } from "./icons.js";
