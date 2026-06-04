// The embeddable builder: the three-zone shell (palette / canvas / right sidebar)
// plus topbar and a code drawer, laid out as nested react-resizable-panels — a
// vertical group (canvas row over code drawer) whose first panel is a horizontal
// group (palette / canvas / sidebar). The palette and code panels are
// collapsible (palette via the topbar toggle, code via its own header), every
// boundary drags to resize, and the canvas panel never unmounts so React Flow
// keeps its viewport across collapses. It renders the canvas from a WorkflowGraph
// and owns the live node/edge view state: drop a palette item to create a node,
// drag between ports to connect (valid targets light up, invalid drops are
// refused), select + Delete to remove. It emits a WorkflowGraph and drives the
// live-run overlay: a simulated trace (via @airun/client's mock run client)
// streams in and lights up the nodes. The right sidebar carries two tabs,
// Inspector and AI Assistant, and auto-switches between them (selecting a node
// shows the Inspector; sending a prompt shows the Assistant).

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
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
import {
  validateWorkflow,
  type NodeType,
  type ValidationIssue,
  type WorkflowGraph,
  type WorkflowNode,
} from "@airun/schema";
import { CATEGORIES, createNode, derivePorts, NODE_TYPES } from "@airun/node-registry";
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
import { Assistant, type AssistantMessage, type AssistantSuggestion } from "./assistant.js";
import { CodeDrawer } from "./code-drawer.js";
import { RunPanel } from "./run-panel.js";
import { RunContext, type RunState } from "./run-context.js";
import { FocusContext, type FocusState } from "./focus-context.js";
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

type SidebarTab = "inspector" | "assistant";

// How long between each node's entrance when the assistant assembles a workflow,
// so the graph builds itself a node at a time rather than appearing all at once.
const STAGGER_MS = 130;

// A scripted workflow the AI Assistant can assemble onto the canvas. `keywords`
// (and the label) are matched case-insensitively against the user's prompt.
export interface AssistantScenario {
  id: string;
  label: string;
  keywords: ReadonlyArray<string>;
  graph: WorkflowGraph;
  /** The assistant's line shown just before the nodes start flying in. */
  reply: string;
  receiptTitle: string;
}

function matchScenario(prompt: string, scenarios: ReadonlyArray<AssistantScenario>): AssistantScenario | undefined {
  const lower = prompt.toLowerCase();
  return scenarios.find(
    (s) => lower.includes(s.label.toLowerCase()) || s.keywords.some((k) => lower.includes(k.toLowerCase())),
  );
}

export interface FlowBuilderProps {
  graph: WorkflowGraph;
  /** Scripted scenarios the AI Assistant can assemble onto the canvas. */
  scenarios?: ReadonlyArray<AssistantScenario>;
}

export function FlowBuilder({ graph, scenarios }: FlowBuilderProps): ReactElement {
  return (
    <ReactFlowProvider>
      <Builder graph={graph} scenarios={scenarios} />
    </ReactFlowProvider>
  );
}

function Builder({ graph, scenarios = [] }: FlowBuilderProps): ReactElement {
  const model = useMemo(() => graphToFlow(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(model.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(model.edges);
  // The graph the canvas is "on": carries variables/tools/secrets/schemas that the
  // canvas itself doesn't render. Starts as the prop, and the AI Assistant swaps it
  // wholesale when it assembles a scenario, so codegen/validation come along.
  const [base, setBase] = useState<WorkflowGraph>(graph);
  const [source, setSource] = useState<Endpoint | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("inspector");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const msgSeq = useRef(0);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [running, setRunning] = useState(false);
  const runHandle = useRef<RunHandle | null>(null);
  const paletteRef = useRef<ImperativePanelHandle>(null);
  const codeRef = useRef<ImperativePanelHandle>(null);
  const runClient = useMemo(() => createMockRunClient(), []);
  const { screenToFlowPosition, fitView } = useReactFlow();
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

  const isBackEdge = (nodeId: string, portId: string | null | undefined): boolean => {
    const type = nodes.find((n) => n.id === nodeId)?.data.node.type;
    return (portId === "continue" && type === "loop") || (portId === "join" && type === "parallel");
  };

  const isValidConnection = (c: Connection): boolean => {
    const sPort = portOf(c.source, c.sourceHandle);
    const tPort = portOf(c.target, c.targetHandle);
    if (!sPort || !tPort || !c.source || !c.target) return false;
    const from: Endpoint = { nodeId: c.source, port: sPort };
    const to: Endpoint = { nodeId: c.target, port: tPort };
    return canConnect(from, to, edgeViews) && !wouldFormCycle(from, to, edgeViews, isBackEdge);
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

  // Remove a node and any edge touching it (mirrors the Delete-key path).
  const deleteNode = (id: string): void => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  };

  // Clone a node's config under a fresh id, nudged down-right, and select the copy.
  // Edges aren't copied — the duplicate starts unconnected.
  const duplicateNode = (src: RFNode<WorkflowNodeData>): void => {
    const id = nextId(src.data.node.type);
    const position = { x: src.position.x + 36, y: src.position.y + 36 };
    const irNode: WorkflowNode = { ...src.data.node, id, layout: { ...src.data.node.layout, ...position } };
    const node: RFNode<WorkflowNodeData> = {
      id,
      type: "workflow",
      position,
      data: { node: irNode, ports: derivePorts(irNode) },
      selected: true,
    };
    setNodes((ns) => ns.map((n): RFNode<WorkflowNodeData> => ({ ...n, selected: false })).concat(node));
  };

  const selectedNodes = nodes.filter((n) => n.selected);
  const selected = selectedNodes.length === 1 ? selectedNodes[0] : undefined;

  // Auto-switch: picking a node pulls the sidebar to the Inspector so its config
  // is right there; sending a prompt pulls it to the AI Assistant (in sendPrompt).
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) setSidebarTab("inspector");
  }, [selectedId]);

  // Candidates for the inspector's ref / var pickers: every other node (a node
  // can't ref itself) plus the workflow's declared variables.
  const bindingCtx = useMemo<BindingContext>(
    () => ({
      nodes: nodes
        .filter((n) => n.id !== selected?.id)
        .map((n) => ({ id: n.id, label: n.data.node.label ?? NODE_TYPES[n.data.node.type].name })),
      variables: base.variables.map((v) => v.name),
      tools: base.tools.map((t) => ({ id: t.id, name: t.name })),
    }),
    [nodes, selected?.id, base.variables, base.tools],
  );

  // The live IR folded back from the canvas — fed to the code drawer to compile
  // and to the run client to trace.
  const liveGraph = useMemo(() => flowToGraph(base, nodes, edges), [base, nodes, edges]);

  // Validation issues that name the selected node, surfaced inline in the
  // inspector. Messages quote the node id ('node_1'), so we match the quoted form
  // to avoid id-substring false positives.
  const selectedIssues = useMemo<ValidationIssue[]>(() => {
    if (!selected) return [];
    const res = validateWorkflow(liveGraph);
    if (res.ok) return [];
    const needle = `'${selected.id}'`;
    return res.issues.filter((i) => i.message.includes(needle));
  }, [selected, liveGraph]);

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

  // Hover-focus: while a node is hovered (and we're not mid-wiring), light that
  // node + its direct neighbours and fade the rest. Suppressed during a connect
  // drag so it doesn't fight the valid-target highlighting.
  const litNodes = useMemo<Set<string>>(() => {
    if (!hovered) return new Set();
    const lit = new Set<string>([hovered]);
    for (const e of edges) {
      if (e.source === hovered) lit.add(e.target);
      if (e.target === hovered) lit.add(e.source);
    }
    return lit;
  }, [hovered, edges]);

  const focus: FocusState = {
    active: hovered !== null && source === null,
    isNodeLit: (id) => litNodes.has(id),
    isEdgeLit: (s, t) => s === hovered || t === hovered,
  };

  // MiniMap dot color = the node's category hue, resolved from the CSS token so
  // the map never hard-codes a palette of its own.
  const hueResolver = useMemo(() => {
    const cache = new Map<string, string>();
    const root = typeof window !== "undefined" ? getComputedStyle(document.documentElement) : null;
    return (n: RFNode<WorkflowNodeData>): string => {
      const hueVar = CATEGORIES[NODE_TYPES[n.data.node.type].category].hueVar;
      let hex = cache.get(hueVar);
      if (hex === undefined) {
        hex = root?.getPropertyValue(hueVar).trim() || "#6e6e7c";
        cache.set(hueVar, hex);
      }
      return hex;
    };
  }, []);

  const connection: ConnectionState = {
    source,
    canConnectTo: (targetNodeId, targetPort) => {
      if (!source) return false;
      const target: Endpoint = { nodeId: targetNodeId, port: targetPort };
      return canConnect(source, target, edgeViews) && !wouldFormCycle(source, target, edgeViews, isBackEdge);
    },
  };

  // The collapsible panels are driven imperatively through their handles, so the
  // topbar toggle and the code-drawer header can open/close them while the panel
  // group stays the single source of truth for the actual sizes.
  const togglePalette = (): void => {
    const p = paletteRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  };
  const setCodeShown = (open: boolean): void => {
    const c = codeRef.current;
    if (!c) return;
    if (open) c.expand();
    else c.collapse();
  };

  const nextMsgId = (): string => `m${(msgSeq.current += 1)}`;
  const pushMessage = (msg: AssistantMessage): void => setMessages((m) => [...m, msg]);

  // Assemble a scenario onto the canvas: swap the base graph (for its tools/vars/
  // secrets), clear what's there, then stagger the nodes in so the workflow builds
  // itself a node at a time. Edges land once every endpoint exists, then we frame
  // the result. The node card's CSS mount-pop punctuates each arrival.
  const buildScenario = (scenario: AssistantScenario): void => {
    const built = graphToFlow(scenario.graph);
    setBase(scenario.graph);
    setNodes([]);
    setEdges([]);
    built.nodes.forEach((node, i) => {
      window.setTimeout(() => setNodes((ns) => [...ns, node]), i * STAGGER_MS);
    });
    window.setTimeout(() => {
      setEdges(built.edges);
      window.setTimeout(() => fitView({ duration: 420, padding: 0.2 }), 80);
    }, built.nodes.length * STAGGER_MS);
  };

  // Send a prompt to the AI Assistant: pull the sidebar to its tab, append the user
  // turn, pulse the typing heartbeat, then either assemble the matched scenario (and
  // post a build receipt) or fall back to what it knows how to build.
  const sendPrompt = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSidebarTab("assistant");
    pushMessage({ id: nextMsgId(), role: "user", kind: "text", text: trimmed });
    setAssistantBusy(true);

    const scenario = matchScenario(trimmed, scenarios);
    window.setTimeout(() => {
      setAssistantBusy(false);
      if (!scenario) {
        const known = scenarios.map((s) => `“${s.label}”`).join(" or ");
        pushMessage({
          id: nextMsgId(),
          role: "assistant",
          kind: "text",
          text: known
            ? `I can assemble a few ready-made workflows so far — try ${known}.`
            : "No scripted workflows are available to assemble yet.",
        });
        return;
      }
      pushMessage({ id: nextMsgId(), role: "assistant", kind: "text", text: scenario.reply });
      buildScenario(scenario);
      const items = scenario.graph.nodes.map((n) => n.label ?? NODE_TYPES[n.type].name);
      window.setTimeout(
        () => pushMessage({ id: nextMsgId(), role: "assistant", kind: "receipt", title: scenario.receiptTitle, items }),
        scenario.graph.nodes.length * STAGGER_MS + 500,
      );
    }, 950);
  };

  return (
    <div className="wf-shell">
      <header className="wf-topbar">
        <button
          type="button"
          className={`wf-sidebar-toggle${paletteOpen ? " is-active" : ""}`}
          onClick={togglePalette}
          aria-pressed={paletteOpen}
          aria-label={paletteOpen ? "Collapse palette" : "Expand palette"}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
        <span className="wf-brand">Flowsmith</span>
        <span className="wf-topbar-sep" />
        <span className="wf-workflow-name">{base.name}</span>
        <span className="wf-workflow-ver">v{base.version}</span>
        <button
          type="button"
          className={`wf-run-trigger${running ? " is-running" : ""}`}
          onClick={running ? stopRun : startRun}
          aria-label={running ? "Stop run" : "Run workflow"}
        >
          {running ? "■ Stop" : "▶ Run"}
        </button>
      </header>

      <PanelGroup direction="vertical" className="wf-body">
        <Panel order={1} minSize={30} className="wf-row-panel">
          <PanelGroup direction="horizontal" className="wf-row">
            <Panel
              ref={paletteRef}
              order={1}
              collapsible
              collapsedSize={0}
              minSize={12}
              defaultSize={18}
              onCollapse={() => setPaletteOpen(false)}
              onExpand={() => setPaletteOpen(true)}
              className="wf-palette-zone"
            >
              <Palette />
            </Panel>
            <PanelResizeHandle className="wf-rsz wf-rsz-col" />

            <Panel order={2} defaultSize={60} className="wf-canvas-panel">
              <main className="wf-canvas-zone" onDrop={onDrop} onDragOver={onDragOver}>
                <ConnectionContext.Provider value={connection}>
                 <RunContext.Provider value={runState}>
                  <FocusContext.Provider value={focus}>
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
                    onNodeMouseEnter={(_e, n) => setHovered(n.id)}
                    onNodeMouseLeave={() => setHovered(null)}
                    isValidConnection={isValidConnection}
                    deleteKeyCode={["Backspace", "Delete"]}
                    minZoom={0.2}
                    maxZoom={2}
                    fitView
                  >
                    <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="wf-bg" />
                    <MiniMap className="wf-minimap" nodeColor={hueResolver} pannable zoomable />
                    <Controls className="wf-controls" showInteractive={false} />
                  </ReactFlow>
                  </FocusContext.Provider>
                 </RunContext.Provider>
                </ConnectionContext.Provider>
                {trace && <RunPanel trace={trace} running={running} onStop={stopRun} onClose={closeRun} />}
              </main>
            </Panel>
            <PanelResizeHandle className="wf-rsz wf-rsz-col" />

            <Panel order={3} minSize={16} defaultSize={22} className="wf-inspector-zone">
              <div className="wf-sidebar">
                <div className="wf-sidebar-tabs" role="tablist" aria-label="Sidebar">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sidebarTab === "inspector"}
                    className={`wf-sidebar-tab${sidebarTab === "inspector" ? " is-active" : ""}`}
                    onClick={() => setSidebarTab("inspector")}
                  >
                    Inspector
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sidebarTab === "assistant"}
                    className={`wf-sidebar-tab${sidebarTab === "assistant" ? " is-active" : ""}`}
                    onClick={() => setSidebarTab("assistant")}
                  >
                    AI Assistant
                  </button>
                </div>
                <div className={`wf-sidebar-body is-${sidebarTab}`}>
                  {sidebarTab === "inspector" ? (
                    selected ? (
                      <Inspector
                        node={selected.data.node}
                        onChange={updateNode}
                        ctx={bindingCtx}
                        issues={selectedIssues}
                        onDelete={() => deleteNode(selected.id)}
                        onDuplicate={() => duplicateNode(selected)}
                      />
                    ) : (
                      <p className="wf-placeholder">
                        {selectedNodes.length > 1
                          ? `${selectedNodes.length} nodes selected.`
                          : "Select a node to edit its configuration."}
                      </p>
                    )
                  ) : (
                    <Assistant
                      messages={messages}
                      busy={assistantBusy}
                      suggestions={scenarios.map((s): AssistantSuggestion => ({ id: s.id, label: s.label }))}
                      onSend={sendPrompt}
                    />
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="wf-rsz wf-rsz-row" />
        <Panel
          ref={codeRef}
          order={2}
          collapsible
          collapsedSize={0}
          minSize={16}
          defaultSize={0}
          onCollapse={() => setCodeOpen(false)}
          onExpand={() => setCodeOpen(true)}
          className="wf-code-panel"
        >
          <CodeDrawer graph={liveGraph} open={codeOpen} onSetOpen={setCodeShown} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
