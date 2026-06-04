// The live-run overlay's link to the node cards. FlowBuilder folds the trace
// event stream into a per-node status map and exposes it here; each node card
// reads its own status to paint a running / done / failed ring. Kept in a tiny
// context (like ConnectionContext) so the cards stay prop-light.

import { createContext } from "react";
import type { StepStatus } from "@airun/client";

export interface RunState {
  /** A node's status in the current run, or undefined if it hasn't run. */
  statusOf: (nodeId: string) => StepStatus | undefined;
  /** Whether a run is being shown at all (drives dimming of idle nodes). */
  active: boolean;
}

export const RunContext = createContext<RunState>({ statusOf: () => undefined, active: false });
