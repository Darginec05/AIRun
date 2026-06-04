# Design & Architecture Guide

How this visual workflow builder is built — the aesthetic rules and the code
architecture. Feed this file to Claude Code as context when extending the UI so
new work stays consistent. Written to be prescriptive, not descriptive.

---

## 1. Aesthetic direction

The look is **confident developer-tool dark mode** — the reference points are
Linear, Vercel, and Raycast. The goal is "precise instrument," not "friendly AI
app." Concretely that means:

- **Near-black, layered surfaces.** Not one flat `#000`. A stack of subtly
  lighter panels separated by hairline borders creates depth without shadows
  doing all the work.
- **One accent, used sparingly.** A single electric indigo-violet. It marks
  _one_ thing at a time: the selected node, the primary button, the control-flow
  edge. If everything is accented, nothing is.
- **Hairline 1px borders over heavy shadows.** Borders at 6–12% white define
  structure. Shadows are reserved for things that genuinely float (popovers,
  the minimap, toasts).
- **Muted-but-distinct category colors.** Each node category gets its own hue,
  but desaturated so the canvas reads calm. Color carries _meaning_ (category,
  edge type), never decoration.
- **No AI-slop tropes.** No gradient-wash backgrounds, no glassmorphism
  everywhere, no emoji, no rounded-corner-with-left-accent-border cards. Depth
  comes from the surface stack + one-pixel borders + the occasional soft shadow.

### Motion

- Springy, short, purposeful. Nodes pop in with a slight overshoot
  (`cubic-bezier(.34,1.56,.64,1)`, ~400ms). Hovers and selections are ~140ms.
- Exactly one ambient animation: the dashed "flow" along control edges. Nothing
  else loops — looping decoration reads as noise.
- Respect `prefers-reduced-motion`.

---

## 2. Design tokens

Everything visual is a CSS custom property on `:root`. Never hard-code a color
or radius in a component — add or reuse a token. The real values:

```css
:root {
  /* Surfaces — a stack, darkest to lightest */
  --bg: #08080b; /* app background */
  --canvas-bg: #0a0a0e; /* canvas, slightly distinct from bg */
  --panel: #0e0e13; /* sidebars, topbar */
  --panel-2: #121218; /* inputs, node bodies */
  --panel-3: #16161d; /* hover states, chips */
  --elevated: #1a1a22; /* popovers, toasts */
  --border: rgba(255, 255, 255, 0.07); /* default hairline */
  --border-strong: rgba(255, 255, 255, 0.12); /* emphasis */
  --border-soft: rgba(255, 255, 255, 0.04); /* internal dividers */

  /* Text — a 4-step ramp, never pure white */
  --text: #e9e9ef;
  --text-2: #a6a6b2;
  --text-3: #6e6e7c;
  --text-4: #4a4a56;

  /* Accent — the one electric color */
  --accent: #7b68ff;
  --accent-bright: #9384ff;
  --accent-dim: #5b4ce0;
  --accent-glow: rgba(123, 104, 255, 0.45); /* for box-shadow halos */
  --accent-soft: rgba(123, 104, 255, 0.12); /* for tinted fills */

  /* Secondary semantic color: data-flow edges */
  --data: #2dd4bf;
  --data-glow: rgba(45, 212, 191, 0.4);

  /* Node category hues — muted, meaning-bearing */
  --cat-trigger: #34d399;
  --cat-ai: #b07cff;
  --cat-tools: #3bb0f8;
  --cat-logic: #f5a623;
  --cat-human: #f472b6;
  --cat-memory: #94a3b8;

  /* Geometry */
  --radius: 10px;
  --radius-lg: 14px;
  --radius-sm: 7px;

  /* Shadows — only for floating things */
  --shadow-node: 0 1px 2px rgba(0, 0, 0, 0.4), 0 6px 18px rgba(0, 0, 0, 0.35);
  --shadow-pop: 0 8px 40px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);

  /* Type */
  --font: "Geist", -apple-system, sans-serif; /* geometric UI sans */
  --mono: "Geist Mono", ui-monospace, monospace; /* real mono for code + IDs */
}
```

Rules of thumb:

- **Text is never `#fff`.** Top of the ramp is `--text` (#e9e9ef). Pure white
  vibrates against near-black.
- **Tints come in pairs:** a `-soft` (≈12% alpha) fill and a `-glow` (≈45%
  alpha) for shadow halos. Use soft for backgrounds, glow for focus rings.
- **A category color → translucent background** via a small helper
  (`hexFade(color, 0.16)`), so icon chips read as "tinted with their hue."

---

## 3. Typography

- **Geist** for UI, **Geist Mono** for anything code-shaped: the code drawer,
  node technical subtitles (`agentLoop`), IDs, endpoints, type labels.
- Using mono for _identifiers inside a product UI_ (not just the code panel) is
  a big part of the "built by engineers" feel. A node titled "Ask the AI" with a
  mono `llm` subtitle instantly signals the real type underneath the friendly
  name.
- Tight letter-spacing on headings (`-0.01em`). Sizes stay small and dense —
  this is an instrument, not a marketing page. UI text 12–13px, labels 10–11px
  uppercase with `letter-spacing: .04–.07em`.

---

## 4. Component patterns

- **Layout is one CSS grid.** The whole app shell is a single
  `grid-template-areas` with `topbar / palette / canvas / inspector / code`.
  The middle row is `1fr`; **every child of a flex/grid track that scrolls
  internally gets `min-height: 0`** or it will blow out the track (this was a
  real bug — the unbounded `1fr` pushed the code drawer off-screen).
- **Spacing via flex/grid `gap`,** never margins between siblings or bare inline
  flow. Survives reordering and keeps rhythm consistent.
- **Inputs:** `--panel-2` fill, `--border` hairline, on focus →
  `border-color: --accent` + `box-shadow: 0 0 0 3px --accent-soft`. That
  3px soft ring on focus is used on _every_ focusable control for consistency.
- **Segmented controls** for 2–3 exclusive options (Static/Dynamic), selects for
  more. Multi-select as a list of toggle rows, not a native multi-select.
- **Friendly name + technical subtitle** on every node and palette item. This is
  the core "non-coder builds, developer owns" idea expressed in one component.
- **The node card is a header row + a dedicated ports rail below it.** Ports are
  positioned by vertical % _within the rail_, not across the whole card — laying
  them over the header makes non-generic port labels (`approved`, `branch:*`)
  collide with the title (this was a real bug). The rail's height scales with the
  port count via a `--port-rows` custom property.
- **No raw IR jargon in the UI.** Binding-source and condition switchers show
  friendly labels — Value / From node / Variable / Template and Compare / All of /
  Any of / Not / Expr — never the IR kind names (`literal`, `ref`, `and`, …). A
  disabled source tab carries a `title` saying _why_ (e.g. "Declare a workflow
  variable first"), so it's never a dead end.
- **Validation is surfaced where you act.** The inspector shows the issues that
  name the selected node inline (matched on the quoted node id in each message),
  alongside a node-id chip and Duplicate / Delete actions; the code drawer keeps
  the always-on graph-wide validity badge.
- **Icon-only controls carry an `aria-label`.** `title` alone is not a reliable
  accessible name; every ✕ / glyph-only button gets an explicit label.

---

## 5. Code architecture

The UI is **plain React via Babel-in-the-browser** (no build step) — every
feature is a small file exporting onto `window`. The important part isn't the
React; it's the **separation of concerns**, which you should keep no matter what
framework you port to:

```
data         node-type registry, categories, port geometry, icons
graph        fixtures: the demo workflows + the canned AI build scripts
codegen      the COMPILER: editor graph → IR → emitted SDK source
sdk-surface  the hand-written @flow/sdk type surface (read-only reference)
nodes        the node card + its body renderers + ports
edges        the two edge types, hover-to-delete, rubber-band geometry
canvas       pan / zoom / drag / connect / minimap / controls
palette      searchable grouped draggable node list
inspector    per-node config forms
assistant    the AI chat panel
codedrawer   syntax-highlit code/IR tabs; validity badge + synced state, copy/download, drag-to-resize
app          state + wiring; owns the graph, selection, viewport
```

### The two assets everything hangs off

1. **`WorkflowGraph` — the IR.** A plain-JSON contract: `nodes` (with `type`,
   `label`, `layout`, typed `ports`, `config`), `edges` (`control` | `data`,
   `from`/`to` port refs), `variables`. The editor's only job is to emit this.
2. **The compiler.** `IR → code` via a **per-node-type emitter registry** plus a
   **control-flow walker**. Each node type maps to exactly one SDK primitive.
   The walker handles router→switch/if-diamond, parallel→`step.parallel`,
   back-edges→bounded revise loops. Keep emitters _pure_:
   `(node, ctx) → string`.

If you keep these two clean, every other feature (live-run, eval, diff,
versioning) is something you read off the IR — not a rewrite.

### Canvas mechanics worth copying

- **Pan/zoom** is one `transform: translate(x,y) scale(z)` on a content layer;
  the dotted grid is a `radial-gradient` background whose `background-position`
  and `background-size` track the same x/y/zoom, so the grid pans/zooms with the
  content for free.
- **Zoom to cursor:** on wheel, compute the new origin so the point under the
  cursor stays fixed: `x' = mx - (mx - x) * (z'/z)`.
- **Ports** are big invisible hit areas (24px) with a small visible dot inside —
  generous targets, precise visuals.
- **Connecting:** on port pointer-down, start a "connect" state; every node
  computes whether each of its ports is a valid target (same kind, opposite
  direction, no dupes, no self) and lights up; a rubber-band bezier follows the
  cursor and snaps when hovering a valid port; pointer-up commits an edge.
- **Two edge types are a hard visual contract:** control = solid accent with an
  animated dashed overlay (`stroke-dashoffset` keyframe); data = thin static
  teal dashes with a type label on hover. Never let them look similar.

---

## 6. Prompting Claude Code to extend this

- **Point it at this file + the tokens.** "Follow DESIGN.md. Use only the CSS
  variables in styles.css — never introduce a new color."
- **Work feature-file by feature-file.** Ask for one concern at a time
  (e.g. "add a cost overlay to nodes.jsx") so changes stay reviewable.
- **Make it emit through the IR.** Any new node type = (1) add to the registry,
  (2) add an emitter, (3) add an inspector form. Three small edits, not one big
  one.
- **Demand the small stuff:** focus rings, hover/dim states, `min-height: 0` on
  scroll containers, `prefers-reduced-motion`, mono for identifiers. These are
  what make it read as polished rather than generic.
- **Reject slop in review:** if a diff adds a gradient background, an emoji, a
  new one-off color, or a rounded-card-with-left-border, send it back.

```

```
