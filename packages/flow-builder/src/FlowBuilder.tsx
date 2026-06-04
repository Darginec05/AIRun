// The embeddable builder: the three-zone shell (palette / canvas / inspector)
// plus topbar and a code-drawer placeholder, all on one CSS grid. It renders the
// React Flow canvas from a WorkflowGraph and owns the live node/edge view state:
// drop a palette item to create a node, drag between ports to connect (valid
// targets light up, invalid drops are refused), select + Delete to remove.
// It emits a WorkflowGraph and never owns runtime — live-run wiring lands later.

import { useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type OnConnectStart,
} from "reactflow";
import type { NodeType, WorkflowGraph } from "@airun/schema";
import { CATEGORIES, createNode, derivePorts, NODE_TYPES } from "@airun/node-registry";
import { WorkflowNodeCard, type WorkflowNodeData } from "./nodes.js";
import { ControlEdge, DataEdge, type DataEdgeData } from "./edges.js";
import { Palette } from "./palette.js";
import { dataTypeLabel, graphToFlow } from "./graph-adapter.js";
import {
  canConnect,
  ConnectionContext,
  wouldFormCycle,
  type ConnectionState,
  type EdgeLike,
  type Endpoint,
} from "./connection.js";
import { NODE_DND_MIME } from "./dnd.js";

const nodeTypes = { workflow: WorkflowNodeCard };
const edgeTypes = { control: ControlEdge, data: DataEdge };

export interface FlowBuilderProps {
  graph: WorkflowGraph;
}

export function FlowBuilder({ graph }: FlowBuilderProps): ReactElement {
  return (
    <ReactFlowProvider>
      <Builder graph={graph} />
    </ReactFlowProvider>
  );
}

function Builder({ graph }: FlowBuilderProps): ReactElement {
  const model = useMemo(() => graphToFlow(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(model.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(model.edges);
  const [source, setSource] = useState<Endpoint | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const seq = useRef(0);
  const nextId = (prefix: string): string => {
    const used = new Set<string>([...nodes.map((n) => n.id), ...edges.map((e) => e.id)]);
    let id = `${prefix}_${(seq.current += 1)}`;
    while (used.has(id)) id = `${prefix}_${(seq.current += 1)}`;
    return id;
  };

  const portOf = (nodeId: string | null | undefined, portId: string | null | undefined) =>
    nodes.find((n) => n.id === nodeId)?.data.ports.find((p) => p.id === portId);

  const edgeViews: EdgeLike[] = edges.map((e) => ({
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
    kind: e.type === "data" ? "data" : "control",
  }));

  const isLoopBack = (nodeId: string, portId: string | null | undefined): boolean =>
    portId === "continue" && nodes.find((n) => n.id === nodeId)?.data.type === "loop";

  const isValidConnection = (c: Connection): boolean => {
    const sPort = portOf(c.source, c.sourceHandle);
    const tPort = portOf(c.target, c.targetHandle);
    if (!sPort || !tPort || !c.source || !c.target) return false;
    const from: Endpoint = { nodeId: c.source, port: sPort };
    const to: Endpoint = { nodeId: c.target, port: tPort };
    return canConnect(from, to, edgeViews) && !wouldFormCycle(from, to, edgeViews, isLoopBack);
  };

  const onConnect = (c: Connection): void => {
    const sPort = portOf(c.source, c.sourceHandle);
    if (!sPort || !c.source || !c.target) return;
    const edge: RFEdge<DataEdgeData> = {
      id: nextId("e"),
      source: c.source,
      target: c.target,
      sourceHandle: c.sourceHandle,
      targetHandle: c.targetHandle,
      type: sPort.kind,
      data: sPort.kind === "data" ? { label: dataTypeLabel(sPort.dataType) } : undefined,
    };
    setEdges((eds) => addEdge(edge, eds));
  };

  const onConnectStart: OnConnectStart = (_event, params) => {
    const port = portOf(params.nodeId, params.handleId);
    if (params.nodeId && port) setSource({ nodeId: params.nodeId, port });
  };
  const onConnectEnd = (): void => setSource(null);

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    const raw = event.dataTransfer.getData(NODE_DND_MIME);
    if (!raw || !Object.prototype.hasOwnProperty.call(NODE_TYPES, raw)) return;
    const type = raw as NodeType;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = nextId(type);
    const def = NODE_TYPES[type];
    const irNode = createNode(type, id, { x: position.x, y: position.y });
    const node: RFNode<WorkflowNodeData> = {
      id,
      type: "workflow",
      position,
      data: {
        type,
        icon: def.icon,
        label: def.name,
        technical: def.technical,
        ports: derivePorts(irNode),
        hueVar: CATEGORIES[def.category].hueVar,
      },
    };
    setNodes((ns) => ns.concat(node));
  };

  const connection: ConnectionState = {
    source,
    canConnectTo: (targetNodeId, targetPort) => {
      if (!source) return false;
      const target: Endpoint = { nodeId: targetNodeId, port: targetPort };
      return canConnect(source, target, edgeViews) && !wouldFormCycle(source, target, edgeViews, isLoopBack);
    },
  };

  return (
    <div className="wf-shell">
      <header className="wf-topbar">
        <span className="wf-brand">Flowsmith</span>
        <span className="wf-topbar-sep" />
        <span className="wf-workflow-name">{graph.name}</span>
        <span className="wf-workflow-ver">v{graph.version}</span>
      </header>

      <aside className="wf-palette-zone">
        <Palette />
      </aside>

      <main className="wf-canvas-zone" onDrop={onDrop} onDragOver={onDragOver}>
        <ConnectionContext.Provider value={connection}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            deleteKeyCode={["Backspace", "Delete"]}
            minZoom={0.2}
            maxZoom={2}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="wf-bg" />
            <MiniMap className="wf-minimap" pannable zoomable />
            <Controls className="wf-controls" showInteractive={false} />
          </ReactFlow>
        </ConnectionContext.Provider>
      </main>

      <aside className="wf-inspector-zone">
        <div className="wf-zone-title">Inspector</div>
        <p className="wf-placeholder">Select a node to edit its configuration.</p>
      </aside>

      <footer className="wf-code-zone">
        <div className="wf-zone-title">Code</div>
        <span className="wf-placeholder">workflow.ts · workflow.graph.json</span>
      </footer>
    </div>
  );
}
