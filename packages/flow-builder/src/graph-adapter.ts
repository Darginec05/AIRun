// Turns a WorkflowGraph (the IR) into React Flow's node/edge model. Positions
// come straight from `layout` (purely visual — never read for anything else),
// ports come from the registry's derivePorts, and each edge's `kind` selects the
// matching custom edge type so the control/data contract is preserved.

import type { Edge as RFEdge, Node as RFNode } from "reactflow";
import type { DataType, Edge, WorkflowGraph, WorkflowNode } from "@airun/schema";
import { derivePorts } from "@airun/node-registry";
import type { WorkflowNodeData } from "./nodes.js";
import type { DataEdgeData } from "./edges.js";

export function dataTypeLabel(t: DataType | undefined): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  return t.schema;
}

function sourcePortDataType(node: WorkflowNode, portId: string): DataType | undefined {
  return derivePorts(node).find((p) => p.id === portId)?.dataType;
}

export interface FlowModel {
  nodes: RFNode<WorkflowNodeData>[];
  edges: RFEdge<DataEdgeData>[];
}

export function graphToFlow(graph: WorkflowGraph): FlowModel {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const nodes: RFNode<WorkflowNodeData>[] = graph.nodes.map((node) => ({
    id: node.id,
    type: "workflow",
    position: { x: node.layout.x, y: node.layout.y },
    data: { node, ports: derivePorts(node) },
  }));

  const edges: RFEdge<DataEdgeData>[] = graph.edges.map((edge) => {
    const src = byId.get(edge.from.nodeId);
    const label = edge.kind === "data" && src ? dataTypeLabel(sourcePortDataType(src, edge.from.portId)) : "";
    return {
      id: edge.id,
      type: edge.kind,
      source: edge.from.nodeId,
      target: edge.to.nodeId,
      sourceHandle: edge.from.portId,
      targetHandle: edge.to.portId,
      data: edge.kind === "data" ? { label } : undefined,
    };
  });

  return { nodes, edges };
}

// The reverse of graphToFlow: fold the live canvas back into a WorkflowGraph so it
// can be compiled or serialized. Each React Flow node already carries its full IR
// node in `data.node`; we only refresh `layout` from the live position (purely
// visual — never read by codegen). Everything not represented on the canvas
// (variables, tools, schemas, secrets, metadata, identity) is taken from `base`.
export function flowToGraph(
  base: WorkflowGraph,
  nodes: RFNode<WorkflowNodeData>[],
  edges: RFEdge<DataEdgeData>[],
): WorkflowGraph {
  const irNodes: WorkflowNode[] = nodes.map((n) => ({
    ...n.data.node,
    layout: { ...n.data.node.layout, x: n.position.x, y: n.position.y },
  }));

  const irEdges: Edge[] = edges
    .filter((e) => e.sourceHandle && e.targetHandle)
    .map((e) => ({
      id: e.id,
      kind: e.type === "data" ? "data" : "control",
      from: { nodeId: e.source, portId: e.sourceHandle as string },
      to: { nodeId: e.target, portId: e.targetHandle as string },
    }));

  return { ...base, nodes: irNodes, edges: irEdges };
}
