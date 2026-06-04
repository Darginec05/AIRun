# @airun/builder

Standalone Vite + React app that wraps `@airun/flow-builder` into the
full-viewport three-zone experience and loads a demo workflow.

```bash
yarn workspace @airun/builder dev      # http://localhost:5173
yarn workspace @airun/builder build    # production bundle into dist/
```

## Status — Phase E slice 1 (live-run overlay, simulated)

Renders the `invoiceGraph` demo (`@airun/schema/examples`) on the React Flow
canvas: category-colored node cards (friendly name + mono technical subtitle),
the two-edge visual contract (control = solid animated accent; data = thin dashed
teal with a hover type-label), derived ports from `@airun/node-registry`, plus a
searchable, category-grouped palette. Pan / zoom / select / minimap work.

Editing is live: drag a palette item onto the canvas to create a node, drag
between ports to connect, and select + Delete (or Backspace) to remove. A single
`canConnect` rule mirrors the IR edge invariants and drives both connection
validation and live port highlighting — valid targets light up, the source pulses,
everything else dims, so what lights up is exactly what can be dropped.

Selecting a node opens the inspector: its head shows the node-id chip and
Duplicate / Delete actions, and any validation issue that names the node is
listed inline so you fix it where you are. Rename the node and edit its config.
Every `Bound` field carries a source switcher with plain-language labels —
**Value** (literal), **From node** (another node's output + an optional
dot-path), **Variable** (a declared workflow variable), or **Template** (text +
nested-binding segments) — and the pickers draw their candidates from the live
canvas; an unavailable source explains why on hover instead of being a dead end.
Tool nodes pick from the workflow's tool registry, and numeric fields
(temperature, max tokens, concurrency, …) carry sensible min/max/step bounds.
List config is editable too: add / remove / rename router routes, conditional
branches, and human-input fields. Adding or removing a list item re-derives
ports and prunes now-dangling edges, so the matching `route:*` / `branch:*` /
`fields.*` port appears or disappears on the canvas at once. Router routes and
conditional branches carry a recursive condition editor (Compare / All of / Any
of / Not / Expr) over the IR `Condition`, with each `compare` operand reusing the
same binding-source switcher. The canvas carries the full IR node, so it can
round-trip a `WorkflowGraph`.

The footer is a live code drawer: expand it to see the owned `workflow.ts` the
canvas compiles to (via `@airun/compiler`) and the `workflow.graph.json` IR
serialization, both recomputed from the canvas as you edit and syntax-highlighted
with Shiki (lazily loaded on first open, so it stays out of the initial bundle).
A mid-edit graph that isn't valid yet shows the failing invariants instead of
code, and not-yet-supported node types surface the compiler's error — so the
drawer doubles as live validation. An always-on validity badge (even when
collapsed) and a synced/​syncing indicator give the canvas a health signal at a
glance; when valid, Copy and Download export the active tab, and the top edge
drags to resize.

The topbar **Run** button starts a live-run overlay: `@airun/client`'s mock run
client streams a simulated trace of the current graph, lit up two ways — each
node card paints a running / done / failed ring (idle nodes dim), and a floating
trace panel logs the steps with their status and timing. The runtime is Node-only
(no in-browser execution) and there's no server yet, so the run is simulated; the
same `RunClient` surface will back a real HTTP/SSE client once a runtime server
exists.
