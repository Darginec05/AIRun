# @airun/builder

Standalone Vite + React app that wraps `@airun/flow-builder` into the
full-viewport three-zone experience and loads a demo workflow.

```bash
yarn workspace @airun/builder dev      # http://localhost:5173
yarn workspace @airun/builder build    # production bundle into dist/
```

## Status — Phase B (drag-create + connect + delete)

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

Not yet wired: inspector forms (C), the live code drawer (D), and live-run via
`@airun/client` + the runtime trace substrate (E). The inspector and code zones
are placeholders for now.
