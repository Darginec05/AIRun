// Hover-focus overlay: when the pointer rests on a node, that node and its direct
// neighbours stay lit while everything else fades back, so a dense graph reads as
// "what connects to this". FlowBuilder computes the connected node/edge sets from
// the hovered node and exposes them here; cards and edges read their own state.
// Kept in a tiny context (like ConnectionContext / RunContext) so they stay
// prop-light. When nothing is hovered, `active` is false and nothing fades.

import { createContext } from "react";

export interface FocusState {
  /** Whether a node is currently hovered (drives the fade of everything else). */
  active: boolean;
  /** Is this node the hovered one or a direct neighbour of it? */
  isNodeLit: (nodeId: string) => boolean;
  /** Is this edge incident to the hovered node? */
  isEdgeLit: (source: string, target: string) => boolean;
}

export const FocusContext = createContext<FocusState>({
  active: false,
  isNodeLit: () => true,
  isEdgeLit: () => true,
});
