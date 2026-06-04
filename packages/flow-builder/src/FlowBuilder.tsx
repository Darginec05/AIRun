// The embeddable builder: the three-zone shell (palette / canvas / inspector)
// plus topbar and a code-drawer placeholder, all on one CSS grid. It renders the
// React Flow canvas from a WorkflowGraph and owns the live node/edge view state:
// drop a palette item to create a node, drag between ports to connect (valid
// targets light up, invalid drops are refused), select + Delete to remove.
// It emits a WorkflowGraph and drives the live-run overlay: a simulated trace
// (via @airun/client's mock run client) streams in and lights up the nodes.

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
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
import type { NodeType, WorkflowGraph, WorkflowNode } from "@airun/schema";
import { createNode, derivePorts, NODE_TYPES } from "@airun/node-registry";
import {
  createMockRunClient,
  reduceTrace,
  startTrace,
  type RunHandle,
  type RunTrace,
  type StepStatus,
  type TraceEvent,
} from "@airun/client";
import { WorkflowNodeCard, type WorkflowNodeData } from "./nodes.js";
import { ControlEdge, DataEdge, type DataEdgeData } from "./edges.js";
import { Palette } from "./palette.js";
import { Inspector, type BindingContext } from "./inspector.js";
import { CodeDrawer } from "./code-drawer.js";
import { RunPanel } from "./run-panel.js";
import { RunContext, type RunState } from "./run-context.js";
import { dataTypeLabel, flowToGraph, graphToFlow } from "./graph-adapter.js";
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
  const [codeOpen, setCodeOpen] = useState(false);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [running, setRunning] = useState(false);
  const runHandle = useRef<RunHandle | null>(null);
  const runClient = useMemo(() => createMockRunClient(), []);
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
    portId === "continue" && nodes.find((n) => n.id === nodeId)?.data.node.type === "loop";

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
    const irNode = createNode(type, id, { x: position.x, y: position.y });
    const node: RFNode<WorkflowNodeData> = {
      id,
      type: "workflow",
      position,
      data: { node: irNode, ports: derivePorts(irNode) },
    };
    setNodes((ns) => ns.concat(node));
  };

  // Inspector edits a node's config/label. Re-derive ports (config drives the
  // dynamic ones) and drop any edge whose endpoint port no longer exists.
  const updateNode = (next: WorkflowNode): void => {
    const ports = derivePorts(next);
    const portIds = new Set(ports.map((p) => p.id));
    setNodes((ns) => ns.map((n) => (n.id === next.id ? { ...n, data: { node: next, ports } } : n)));
    setEdges((es) =>
      es.filter((e) => {
        if (e.source === next.id && e.sourceHandle && !portIds.has(e.sourceHandle)) return false;
        if (e.target === next.id && e.targetHandle && !portIds.has(e.targetHandle)) return false;
        return true;
      }),
    );
  };

  const selectedNodes = nodes.filter((n) => n.selected);
  const selected = selectedNodes.length === 1 ? selectedNodes[0] : undefined;

  // Candidates for the inspector's ref / var pickers: every other node (a node
  // can't ref itself) plus the workflow's declared variables.
  const bindingCtx = useMemo<BindingContext>(
    () => ({
      nodes: nodes
        .filter((n) => n.id !== selected?.id)
        .map((n) => ({ id: n.id, label: n.data.node.label ?? NODE_TYPES[n.data.node.type].name })),
      variables: graph.variables.map((v) => v.name),
    }),
    [nodes, selected?.id, graph.variables],
  );

  // The live IR folded back from the canvas — fed to the code drawer to compile
  // and to the run client to trace.
  const liveGraph = useMemo(() => flowToGraph(graph, nodes, edges), [graph, nodes, edges]);

  // Trigger a simulated run: stream trace events into a folded RunTrace. The mock
  // client keys each step by node id, so the canvas overlay maps them directly.
  const startRun = (): void => {
    runHandle.current?.cancel();
    setTrace(null);
    setRunning(true);
    const onEvent = (event: TraceEvent): void => {
      setTrace((prev) =>
        reduceTrace(prev ?? startTrace(event.runId, event.type === "run.started" ? event.input : null), event),
      );
      if (event.type === "run.completed" || event.type === "run.failed") setRunning(false);
    };
    runHandle.current = runClient.startRun(liveGraph, { trigger: "manual" }, onEvent);
  };

  const stopRun = (): void => {
    runHandle.current?.cancel();
    runHandle.current = null;
    setRunning(false);
  };

  const closeRun = (): void => {
    stopRun();
    setTrace(null);
  };

  useEffect(() => () => runHandle.current?.cancel(), []);

  // Per-node run status the node cards read to paint their rings.
  const runState = useMemo<RunState>(() => {
    const byNode = new Map<string, StepStatus>();
    for (const s of trace?.steps ?? []) byNode.set(s.stepKey, s.status);
    return { statusOf: (id) => byNode.get(id), active: trace !== null };
  }, [trace]);

  const connection: ConnectionState = {
    source,
    canConnectTo: (targetNodeId, targetPort) => {
      if (!source) return false;
      const target: Endpoint = { nodeId: targetNodeId, port: targetPort };
      return canConnect(source, target, edgeViews) && !wouldFormCycle(source, target, edgeViews, isLoopBack);
    },
  };

  return (
    <div className={`wf-shell${codeOpen ? " is-code-open" : ""}`}>
      <header className="wf-topbar">
        <span className="wf-brand">Flowsmith</span>
        <span className="wf-topbar-sep" />
        <span className="wf-workflow-name">{graph.name}</span>
        <span className="wf-workflow-ver">v{graph.version}</span>
        <button
          type="button"
          className={`wf-run-trigger${running ? " is-running" : ""}`}
          onClick={running ? stopRun : startRun}
        >
          {running ? "■ Stop" : "▶ Run"}
        </button>
      </header>

      <aside className="wf-palette-zone">
        <Palette />
      </aside>

      <main className="wf-canvas-zone" onDrop={onDrop} onDragOver={onDragOver}>
        <ConnectionContext.Provider value={connection}>
         <RunContext.Provider value={runState}>
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
         </RunContext.Provider>
        </ConnectionContext.Provider>
        {trace && <RunPanel trace={trace} running={running} onStop={stopRun} onClose={closeRun} />}
      </main>

      <aside className="wf-inspector-zone">
        <div className="wf-zone-title">Inspector</div>
        {selected ? (
          <Inspector node={selected.data.node} onChange={updateNode} ctx={bindingCtx} />
        ) : (
          <p className="wf-placeholder">
            {selectedNodes.length > 1
              ? `${selectedNodes.length} nodes selected.`
              : "Select a node to edit its configuration."}
          </p>
        )}
      </aside>

      <CodeDrawer graph={liveGraph} open={codeOpen} onSetOpen={setCodeOpen} />
    </div>
  );
}
