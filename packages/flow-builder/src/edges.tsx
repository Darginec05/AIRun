// The two-edge visual contract. Control = a solid accent bezier with an animated
// dashed overlay (the one ambient motion on the canvas). Data = a thin static
// teal dash with its data type as a hover label. They must never read alike.
// Each edge also lays down a wide transparent path as a generous hit area.

import type { ReactElement } from "react";
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from "reactflow";

export interface DataEdgeData {
  label: string;
}

function bezier(props: EdgeProps): [string, number, number] {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  return [path, labelX, labelY];
}

export function ControlEdge(props: EdgeProps): ReactElement {
  const [path] = bezier(props);
  return (
    <>
      <path d={path} className="wf-edge-hit" fill="none" />
      <path d={path} className={`wf-edge-control${props.selected ? " is-selected" : ""}`} fill="none" />
      <path d={path} className="wf-edge-control-flow" fill="none" />
    </>
  );
}

export function DataEdge(props: EdgeProps<DataEdgeData>): ReactElement {
  const [path, labelX, labelY] = bezier(props);
  return (
    <>
      <path d={path} className="wf-edge-hit" fill="none" />
      <path d={path} className={`wf-edge-data${props.selected ? " is-selected" : ""}`} fill="none" />
      {props.data?.label ? (
        <EdgeLabelRenderer>
          <div
            className="wf-edge-data-label"
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
          >
            {props.data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
