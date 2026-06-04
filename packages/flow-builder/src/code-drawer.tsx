// The code drawer (zone D): a collapsible footer that shows the live deliverable
// — the owned `workflow.ts` the canvas compiles to, plus the `workflow.graph.json`
// IR serialization. It recompiles from the live graph (debounced) whenever the
// canvas changes while open, and surfaces validity at a glance even when collapsed
// so the canvas always has a health signal. A mid-edit graph is often not yet
// valid, so we validate first and surface the failing invariants instead of
// compiling; unsupported-node codegen gaps surface as the compiler's CompileError.
// The "synced" heartbeat pulses on every graph change so the live-code link is
// felt, not just claimed. The drawer never owns runtime. Resize/collapse is the
// parent's PanelGroup; the drawer only asks to open or close via onSetOpen.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { validateWorkflow, type WorkflowGraph } from "@airun/schema";
import { compileWorkflow, CompileError } from "@airun/compiler";
import { highlightCode, type CodeLang } from "./highlight.js";

type CodeTab = "ts" | "json";

const TABS: ReadonlyArray<{ id: CodeTab; label: string; badge: string }> = [
  { id: "ts", label: "workflow.ts", badge: "TS" },
  { id: "json", label: "workflow.graph.json", badge: "{ }" },
];

const SKELETON = `// Drag nodes onto the canvas — or describe your agent — and the workflow
// appears here, one SDK primitive per node. This file is yours to own.

import { defineWorkflow } from "@airun/sdk";

export default defineWorkflow({
  // A trigger and its steps will be generated as you build.
});
`;

// Debounce a value so the heavy compile/validate/highlight only runs after edits
// settle, not on every keystroke from the inspector.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface CodeView {
  text: string;
  lang: CodeLang;
  invalid: boolean;
}

type Validity = { ok: true } | { ok: false; count: number };

function buildView(graph: WorkflowGraph, tab: CodeTab): CodeView {
  if (tab === "json") return { text: JSON.stringify(graph, null, 2), lang: "json", invalid: false };

  // Never show a blank editor — a bare canvas gets a skeleton that teaches the
  // output shape instead of an empty pane.
  if (graph.nodes.length === 0) return { text: SKELETON, lang: "typescript", invalid: false };

  const result = validateWorkflow(graph);
  if (!result.ok) {
    const issues = result.issues
      .map((i) => `//   [${i.invariant}] ${i.message}${i.path ? ` (${i.path})` : ""}`)
      .join("\n");
    return { text: `// Workflow not yet valid — fix these to generate code:\n${issues}`, lang: "typescript", invalid: true };
  }
  try {
    return { text: compileWorkflow(graph), lang: "typescript", invalid: false };
  } catch (err) {
    const message = err instanceof CompileError ? err.message : String(err);
    return { text: `// Cannot generate code yet:\n//   ${message}`, lang: "typescript", invalid: true };
  }
}

export interface CodeDrawerProps {
  graph: WorkflowGraph;
  open: boolean;
  /** Ask the parent to expand (true) or collapse (false) the code panel. */
  onSetOpen: (open: boolean) => void;
}

export function CodeDrawer({ graph, open, onSetOpen }: CodeDrawerProps): ReactElement {
  const [tab, setTab] = useState<CodeTab>("ts");
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [html, setHtml] = useState<string | null>(null);
  const [pulse, setPulse] = useState(false);
  const debouncedGraph = useDebounced(graph, 250);

  // Heartbeat: any canvas edit kicks a brief pulse that settles after ~800ms, so
  // a glance at the dot confirms the code is tracking even before the debounce
  // recompiles. Skips the initial mount so it only fires on real edits.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 800);
    return () => clearTimeout(t);
  }, [graph]);
  const live = pulse || graph !== debouncedGraph;

  // Cheap validity is computed from the settled graph regardless of tab/open, so
  // the collapsed header can show a health badge.
  const validity = useMemo<Validity>(() => {
    const r = validateWorkflow(debouncedGraph);
    return r.ok ? { ok: true } : { ok: false, count: r.issues.length };
  }, [debouncedGraph]);

  const view = useMemo(() => (open ? buildView(debouncedGraph, tab) : null), [debouncedGraph, tab, open]);
  const lineCount = view ? view.text.split("\n").length : 0;

  // Highlighting is async (Shiki builds its grammars lazily). Skip it for invalid
  // views so the error styling shows; otherwise show plain text until the themed
  // HTML arrives, and drop stale results.
  useEffect(() => {
    if (!view || view.invalid) {
      setHtml(null);
      return;
    }
    let active = true;
    void highlightCode(view.text, view.lang).then(
      (out) => {
        if (active) setHtml(out);
      },
      () => {
        if (active) setHtml(null);
      },
    );
    return () => {
      active = false;
    };
  }, [view]);

  const selectTab = (id: CodeTab): void => {
    setTab(id);
    setCopied("idle");
    onSetOpen(true);
  };

  const canExport = !!view && !view.invalid;

  const copy = (): void => {
    if (!canExport || !view) return;
    void navigator.clipboard.writeText(view.text).then(
      () => {
        setCopied("ok");
        setTimeout(() => setCopied("idle"), 1200);
      },
      () => {
        setCopied("fail");
        setTimeout(() => setCopied("idle"), 1600);
      },
    );
  };

  const download = (): void => {
    if (!canExport || !view) return;
    const name = tab === "ts" ? "workflow.ts" : "workflow.graph.json";
    const blob = new Blob([view.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <footer className={`wf-code-zone${open ? " is-open" : ""}`}>
      <div className="wf-code-head">
        <button
          type="button"
          className="wf-code-toggle"
          onClick={() => onSetOpen(!open)}
          aria-expanded={open}
          aria-controls="wf-code-panel"
          aria-label={open ? "Collapse code panel" : "Expand code panel"}
        >
          <span className="wf-code-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="wf-zone-title">Code</span>
        </button>

        <div className="wf-code-tabs" role="tablist" aria-label="Code view">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={open && t.id === tab}
              aria-controls="wf-code-panel"
              className={`wf-code-tab${open && t.id === tab ? " is-active" : ""}`}
              onClick={() => selectTab(t.id)}
            >
              <span className={`wf-code-badge is-${t.id}`} aria-hidden="true">
                {t.badge}
              </span>
              {t.label}
            </button>
          ))}
        </div>

        <span
          className={`wf-code-validity${validity.ok ? " is-ok" : " is-bad"}`}
          title={validity.ok ? "Workflow is valid" : `${validity.count} validation issue(s)`}
        >
          {validity.ok ? "✓ Valid" : `${validity.count} issue${validity.count === 1 ? "" : "s"}`}
        </span>
        <span className={`wf-code-sync${live ? " is-syncing" : ""}`} aria-live="polite">
          <span className="wf-code-sync-dot" aria-hidden="true" />
          {live ? "Syncing…" : "Synced with canvas"}
        </span>

        {open && (
          <div className="wf-code-actions">
            <span className="wf-sr-live" aria-live="polite">
              {copied === "ok" ? "Copied to clipboard" : copied === "fail" ? "Copy failed" : ""}
            </span>
            <button type="button" className="wf-code-btn" onClick={copy} disabled={!canExport}>
              {copied === "ok" ? "Copied" : copied === "fail" ? "Failed" : "Copy"}
            </button>
            <button type="button" className="wf-code-btn" onClick={download} disabled={!canExport}>
              Download
            </button>
          </div>
        )}
      </div>
      {open && view && (
        // key by tab so switching files resets scroll to the top (no bleed-over).
        <div id="wf-code-panel" role="tabpanel" className="wf-code-body" key={tab}>
          <div className="wf-code-pre-wrap">
            <div className="wf-code-gutter" aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            {html && !view.invalid ? (
              <div className="wf-shiki" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <pre className={`wf-code-pre${view.invalid ? " is-invalid" : ""}`}>{view.text}</pre>
            )}
          </div>
        </div>
      )}
    </footer>
  );
}
