// The code drawer (zone D): a collapsible footer that shows the live deliverable
// — the owned `workflow.ts` the canvas compiles to, plus the `workflow.graph.json`
// IR serialization. It recompiles from the live graph whenever the canvas changes
// while open. A mid-edit graph is often not yet valid, so we validate first and
// surface the failing invariants instead of compiling; unsupported-node codegen
// gaps surface as the compiler's CompileError. The drawer never owns runtime.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { validateWorkflow, type WorkflowGraph } from "@airun/schema";
import { compileWorkflow, CompileError } from "@airun/compiler";
import { highlightCode, type CodeLang } from "./highlight.js";

type CodeTab = "ts" | "json";

const TABS: ReadonlyArray<{ id: CodeTab; label: string }> = [
  { id: "ts", label: "workflow.ts" },
  { id: "json", label: "workflow.graph.json" },
];

interface CodeView {
  text: string;
  lang: CodeLang;
  invalid: boolean;
}

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
}

export function CodeDrawer({ graph, open, onSetOpen }: CodeDrawerProps): ReactElement {
  const [tab, setTab] = useState<CodeTab>("ts");
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const view = useMemo(() => (open ? buildView(graph, tab) : null), [graph, tab, open]);

  // Highlighting is async (Shiki builds its grammars lazily); show the plain text
  // until the themed HTML for the current view arrives, and drop stale results.
  useEffect(() => {
    if (!view) {
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
    setCopied(false);
    onSetOpen(true);
  };

  const copy = (): void => {
    if (!view) return;
    void navigator.clipboard.writeText(view.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  return (
    <footer className={`wf-code-zone${open ? " is-open" : ""}`}>
      <div className="wf-code-head">
        <button
          type="button"
          className="wf-code-toggle"
          onClick={() => onSetOpen(!open)}
          aria-expanded={open}
          title={open ? "Collapse code" : "Expand code"}
        >
          <span className="wf-code-chevron">{open ? "▾" : "▸"}</span>
          <span className="wf-zone-title">Code</span>
        </button>
        <div className="wf-code-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={open && t.id === tab}
              className={`wf-code-tab${open && t.id === tab ? " is-active" : ""}`}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {open && (
          <button type="button" className="wf-code-copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {open && view && (
        <div className="wf-code-body">
          {html ? (
            <div className="wf-shiki" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className={`wf-code-pre${view.invalid ? " is-invalid" : ""}`}>{view.text}</pre>
          )}
        </div>
      )}
    </footer>
  );
}
