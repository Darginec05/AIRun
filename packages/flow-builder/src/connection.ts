// The connection contract, shared by the canvas's `isValidConnection` (snapping
// + drop validation) and the node ports' valid-target highlighting — one rule
// set, so what lights up is exactly what can be dropped. Mirrors the IR edge
// invariants: the local pairwise rule (`canConnect`: control↔control / data↔data,
// out→in, no self, compatible data types, no duplicate) plus the graph-global
// acyclicity rule (`wouldFormCycle`: data-is-dag, control-cycles-only-via-loop).

import { createContext } from "react";
import type { DataType, Port } from "@airun/schema";

export interface Endpoint {
  nodeId: string;
  port: Port;
}

/** A minimal edge view — what we need to detect duplicates and cycles. */
export interface EdgeLike {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  kind: "control" | "data";
}

export function dataCompatible(a: DataType | undefined, b: DataType | undefined): boolean {
  if (!a || !b) return true;
  if (a === "any" || b === "any") return true;
  const aSchema = typeof a !== "string";
  const bSchema = typeof b !== "string";
  if (aSchema && bSchema) return a.schema === b.schema;
  if (aSchema || bSchema) return false;
  return a === b;
}

/**
 * Whether an edge may be formed between two endpoints. `source` is the endpoint
 * the drag started from; orientation is normalized to out→in so the rule holds
 * regardless of which end the user grabbed first.
 */
export function canConnect(source: Endpoint, target: Endpoint, edges: readonly EdgeLike[]): boolean {
  const [from, to] = source.port.direction === "out" ? [source, target] : [target, source];
  if (from.port.direction !== "out" || to.port.direction !== "in") return false;
  if (from.nodeId === to.nodeId) return false;
  if (from.port.kind !== to.port.kind) return false;
  if (from.port.kind === "data" && !dataCompatible(from.port.dataType, to.port.dataType)) return false;
  const dup = edges.some(
    (e) =>
      e.source === from.nodeId &&
      e.sourceHandle === from.port.id &&
      e.target === to.nodeId &&
      e.targetHandle === to.port.id,
  );
  return !dup;
}

/**
 * Whether forming the (normalized out→in) edge would close a forbidden cycle.
 * Data edges must keep the data subgraph acyclic; control flow may only loop
 * back through a loop node's `continue` port or a parallel node's `join` port,
 * so those back-edges are excluded from the reachability check — and a new edge
 * that is itself such a back-edge can never be forbidden. `isBackEdge` reports
 * whether (nodeId, portId) is one of those legal back-edge targets. Mirrors the
 * IR's `data-is-dag` and `control-cycles-only-via-loop` invariants.
 */
export function wouldFormCycle(
  source: Endpoint,
  target: Endpoint,
  edges: readonly EdgeLike[],
  isBackEdge: (nodeId: string, portId: string | null | undefined) => boolean,
): boolean {
  const [from, to] = source.port.direction === "out" ? [source, target] : [target, source];
  const kind = from.port.kind;
  if (kind === "control" && isBackEdge(to.nodeId, to.port.id)) return false;

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== kind) continue;
    if (kind === "control" && isBackEdge(e.target, e.targetHandle)) continue;
    const outs = adj.get(e.source);
    if (outs) outs.push(e.target);
    else adj.set(e.source, [e.target]);
  }

  // The new edge from→to closes a cycle iff `to` can already reach `from`.
  const seen = new Set<string>();
  const stack = [to.nodeId];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) continue;
    if (node === from.nodeId) return true;
    seen.add(node);
    for (const next of adj.get(node) ?? []) stack.push(next);
  }
  return false;
}

export interface ConnectionState {
  /** The port a connection drag started from, or null when not connecting. */
  source: Endpoint | null;
  /** Whether the in-progress connection could land on this candidate port. */
  canConnectTo: (targetNodeId: string, targetPort: Port) => boolean;
}

export const ConnectionContext = createContext<ConnectionState>({
  source: null,
  canConnectTo: () => false,
});
