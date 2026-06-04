// The node card: a category-tinted icon chip, a friendly name, and a mono
// technical subtitle (the SDK primitive underneath). Ports become React Flow
// handles — control/data styled distinctly, ins on the left, outs on the right,
// distributed vertically. Non-generic port names (approved, branch:*, …) get a
// small inset label so the control surface reads at a glance.

import { useContext, type CSSProperties, type ReactElement } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { NodeType, Port } from "@airun/schema";
import type { IconKey } from "@airun/node-registry";
import { Icon } from "./icons.js";
import { ConnectionContext } from "./connection.js";

export interface WorkflowNodeData {
  type: NodeType;
  icon: IconKey;
  label: string;
  technical: string;
  ports: Port[];
  /** CSS variable name for the category hue, e.g. "--cat-ai". */
  hueVar: string;
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

export function WorkflowNodeCard({ id, data, selected }: NodeProps<WorkflowNodeData>): ReactElement {
  const ins = place(data.ports, "in");
  const outs = place(data.ports, "out");
  const style = { "--node-hue": `var(${data.hueVar})` } as CSSProperties;

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
    <div className={`wf-node${selected ? " is-selected" : ""}`} style={style}>
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

      <div className="wf-node-head">
        <span className="wf-node-icon">
          <Icon name={data.icon} />
        </span>
        <div className="wf-node-titles">
          <div className="wf-node-name">{data.label}</div>
          <div className="wf-node-type">{data.technical}</div>
        </div>
      </div>

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
  );
}
