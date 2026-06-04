// Turns a WorkflowGraph (the IR) into React Flow's node/edge model. Positions
// come straight from `layout` (purely visual — never read for anything else),
// ports come from the registry's derivePorts, and each edge's `kind` selects the
// matching custom edge type so the control/data contract is preserved.

import type { Edge as RFEdge, Node as RFNode } from "reactflow";
import type { DataType, WorkflowGraph, WorkflowNode } from "@airun/schema";
import { CATEGORIES, derivePorts, nodeDef } from "@airun/node-registry";
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

  const nodes: RFNode<WorkflowNodeData>[] = graph.nodes.map((node) => {
    const def = nodeDef(node.type);
    return {
      id: node.id,
      type: "workflow",
      position: { x: node.layout.x, y: node.layout.y },
      data: {
        type: node.type,
        icon: def.icon,
        label: node.label ?? def.name,
        technical: def.technical,
        ports: derivePorts(node),
        hueVar: CATEGORIES[def.category].hueVar,
      },
    };
  });

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
