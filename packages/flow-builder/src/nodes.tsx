// The node card: a header (category-tinted icon chip, friendly name, mono
// technical subtitle) over a ports rail. Ports become React Flow handles —
// control/data styled distinctly, ins on the left, outs on the right. The rail
// is a dedicated region below the header so non-generic port labels (approved,
// branch:*, …) sit on their own rows and never overlap the title. Run status is
// shown by both a colored ring and a shape glyph, so it doesn't rely on color
// alone.

import { useContext, type CSSProperties, type ReactElement } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { Port, WorkflowNode } from "@airun/schema";
import { CATEGORIES, NODE_TYPES } from "@airun/node-registry";
import { Icon } from "./icons.js";
import { ConnectionContext } from "./connection.js";
import { RunContext } from "./run-context.js";
import { FocusContext } from "./focus-context.js";
import type { StepStatus } from "@airun/client";

export interface WorkflowNodeData {
  /** The IR node — the single source of truth for type, label, and config. */
  node: WorkflowNode;
  /** Static + derived ports, materialized for handle rendering. */
  ports: Port[];
}

interface PlacedPort {
  port: Port;
  top: number;
}

function place(ports: Port[], direction: "in" | "out"): PlacedPort[] {
  const list = ports
    .filter((p) => p.direction === direction)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "control" ? -1 : 1));
  return list.map((port, i) => ({ port, top: ((i + 1) / (list.length + 1)) * 100 }));
}

const isGeneric = (port: Port): boolean => port.name === "in" || port.name === "out";

// A shape glyph per run status, so the state reads without relying on color.
const RUN_GLYPH: Record<StepStatus, string> = {
  running: "▸",
  completed: "✓",
  failed: "✕",
};

export function WorkflowNodeCard({ id, data, selected }: NodeProps<WorkflowNodeData>): ReactElement {
  const def = NODE_TYPES[data.node.type];
  const label = data.node.label ?? def.name;
  const ins = place(data.ports, "in");
  const outs = place(data.ports, "out");
  const rows = Math.max(ins.length, outs.length);
  const style = {
    "--node-hue": `var(${CATEGORIES[def.category].hueVar})`,
    "--port-rows": rows,
  } as CSSProperties;

  const run = useContext(RunContext);
  const runStatus = run.statusOf(id);
  const runClass = run.active ? (runStatus ? ` is-run-${runStatus}` : " is-run-idle") : "";

  const focus = useContext(FocusContext);
  const focusClass = focus.active && !focus.isNodeLit(id) ? " is-faded" : "";

  const connect = useContext(ConnectionContext);
  const portClass = (port: Port): string => {
    let cls = `wf-port wf-port-${port.kind}`;
    if (connect.source) {
      const isSource = connect.source.nodeId === id && connect.source.port.id === port.id;
      if (isSource) cls += " is-source";
      else if (connect.canConnectTo(id, port)) cls += " is-valid-target";
      else cls += " is-dim";
    }
    return cls;
  };

  return (
    <div className={`wf-node${selected ? " is-selected" : ""}${runClass}${focusClass}`} style={style}>
      <div className="wf-node-head">
        <span className="wf-node-icon">
          <Icon name={def.icon} />
        </span>
        <div className="wf-node-titles">
          <div className="wf-node-name">{label}</div>
          <div className="wf-node-type">{def.technical}</div>
        </div>
        {runStatus && (
          <span className={`wf-node-run-badge is-run-${runStatus}`} aria-label={`run ${runStatus}`} title={runStatus}>
            {RUN_GLYPH[runStatus]}
          </span>
        )}
      </div>

      {rows > 0 && (
        <div className="wf-node-ports">
          {ins.map(({ port, top }) => (
            <Handle
              key={port.id}
              id={port.id}
              type="target"
              position={Position.Left}
              className={portClass(port)}
              style={{ top: `${top}%` }}
            />
          ))}
          {ins.map(({ port, top }) =>
            isGeneric(port) ? null : (
              <span key={`l-${port.id}`} className="wf-port-label wf-port-label-in" style={{ top: `${top}%` }}>
                {port.name}
              </span>
            ),
          )}
          {outs.map(({ port, top }) => (
            <Handle
              key={port.id}
              id={port.id}
              type="source"
              position={Position.Right}
              className={portClass(port)}
              style={{ top: `${top}%` }}
            />
          ))}
          {outs.map(({ port, top }) =>
            isGeneric(port) ? null : (
              <span key={`r-${port.id}`} className="wf-port-label wf-port-label-out" style={{ top: `${top}%` }}>
                {port.name}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}
