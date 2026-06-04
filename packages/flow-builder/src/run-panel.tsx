// The live-run trace panel: a floating timeline over the canvas that mirrors the
// node-card overlay. It renders the run's status and each step as it streams in
// (status dot, label, duration), so the run reads as both canvas highlighting and
// an ordered log. Purely a view over the RunTrace FlowBuilder folds from events.

import type { ReactElement } from "react";
import type { RunStatus, RunTrace } from "@airun/client";

const RUN_LABEL: Record<RunStatus, string> = {
  running: "Running",
  suspended: "Suspended",
  completed: "Completed",
  failed: "Failed",
};

export interface RunPanelProps {
  trace: RunTrace;
  running: boolean;
  onStop: () => void;
  onClose: () => void;
}

export function RunPanel({ trace, running, onStop, onClose }: RunPanelProps): ReactElement {
  const status: RunStatus = running ? "running" : trace.status;
  return (
    <div className="wf-run-panel">
      <div className="wf-run-head">
        <span className={`wf-run-status is-${status}`}>{running ? "Running" : RUN_LABEL[trace.status]}</span>
        <span className="wf-run-id">{trace.runId}</span>
        <span className="wf-run-actions">
          {running && (
            <button type="button" className="wf-run-btn" onClick={onStop}>
              Stop
            </button>
          )}
          <button type="button" className="wf-run-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </span>
      </div>
      <ol className="wf-run-steps">
        {trace.steps.length === 0 && <li className="wf-run-empty">Waiting for the first step…</li>}
        {trace.steps.map((s) => (
          <li key={s.stepKey} className={`wf-run-step is-${s.status}`}>
            <span className="wf-run-dot" />
            <span className="wf-run-step-label">{s.label}</span>
            {s.durationMs !== undefined && <span className="wf-run-step-time">{s.durationMs}ms</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
