// The code drawer (zone D): a collapsible footer that shows the live deliverable
// — the owned `workflow.ts` the canvas compiles to, plus the `workflow.graph.json`
// IR serialization. It recompiles from the live graph (debounced) whenever the
// canvas changes while open, and surfaces validity at a glance even when collapsed
// so the canvas always has a health signal. A mid-edit graph is often not yet
// valid, so we validate first and surface the failing invariants instead of
// compiling; unsupported-node codegen gaps surface as the compiler's CompileError.
// The drawer never owns runtime.

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement } from "react";
import { validateWorkflow, type WorkflowGraph } from "@airun/schema";
import { compileWorkflow, CompileError } from "@airun/compiler";
import { highlightCode, type CodeLang } from "./highlight.js";

type CodeTab = "ts" | "json";

const TABS: ReadonlyArray<{ id: CodeTab; label: string }> = [
  { id: "ts", label: "workflow.ts" },
  { id: "json", label: "workflow.graph.json" },
];

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
  onSetOpen: (open: boolean) => void;
  /** Sets the drawer's grid-track height (px) as the top edge is dragged. */
  onHeightChange?: (px: number) => void;
}

export function CodeDrawer({ graph, open, onSetOpen, onHeightChange }: CodeDrawerProps): ReactElement {
  const [tab, setTab] = useState<CodeTab>("ts");
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [html, setHtml] = useState<string | null>(null);
  const debouncedGraph = useDebounced(graph, 250);
  const syncing = graph !== debouncedGraph;

  // Cheap validity is computed from the settled graph regardless of tab/open, so
  // the collapsed header can show a health badge.
  const validity = useMemo<Validity>(() => {
    const r = validateWorkflow(debouncedGraph);
    return r.ok ? { ok: true } : { ok: false, count: r.issues.length };
  }, [debouncedGraph]);

  const view = useMemo(() => (open ? buildView(debouncedGraph, tab) : null), [debouncedGraph, tab, open]);

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

  // Resize: drag the top edge. Drawer is anchored to the viewport bottom, so the
  // target height is (viewport bottom − pointer Y), clamped to a sane band.
  const resizing = useRef(false);
  const onResizePointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!onHeightChange) return;
    if (!open) onSetOpen(true);
    resizing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizePointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!resizing.current || !onHeightChange) return;
    const next = window.innerHeight - e.clientY;
    onHeightChange(Math.max(140, Math.min(next, window.innerHeight * 0.8)));
  };
  const onResizePointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    resizing.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <footer className={`wf-code-zone${open ? " is-open" : ""}`}>
      {open && onHeightChange && (
        <div
          className="wf-code-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize code panel"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
        />
      )}
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

        <span
          className={`wf-code-validity${validity.ok ? " is-ok" : " is-bad"}`}
          title={validity.ok ? "Workflow is valid" : `${validity.count} validation issue(s)`}
        >
          {validity.ok ? "✓ Valid" : `${validity.count} issue${validity.count === 1 ? "" : "s"}`}
        </span>
        <span className="wf-code-sync" aria-live="polite">
          {syncing ? "Syncing…" : "Synced"}
        </span>

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
              {t.label}
            </button>
          ))}
        </div>
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
        <div id="wf-code-panel" role="tabpanel" className="wf-code-body">
          {html && !view.invalid ? (
            <div className="wf-shiki" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className={`wf-code-pre${view.invalid ? " is-invalid" : ""}`}>{view.text}</pre>
          )}
        </div>
      )}
    </footer>
  );
}
