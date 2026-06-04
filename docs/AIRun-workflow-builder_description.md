# Product Spec — Visual Workflow Builder for AI Agents

A build brief for Claude Code. This describes **what to build and why**; pair it
with `DESIGN.md` (the visual + code-style rules). Read both before scaffolding.

---

## 1. One-line pitch

**Figma-meets-n8n for AI agents — but the export is real code a developer owns.**

Non-technical people (marketers, sales, ops) build LLM/agent workflows two ways:
by **dragging nodes** on a canvas, or by **describing** what they want to an AI
assistant that builds it for them. The output is **production TypeScript** built
on a clean agent SDK that a developer then owns, edits, versions, and ships.

## 2. The core bet (this drives every decision)

The canvas is where you _author_, but **the generated code is the hero**. The wow
moment is a non-coder building an agent visually and watching real, idiomatic
code appear live. Three properties make this different from n8n / Flowise /
Langflow:

1. **The export is owned source, not runtime lock-in.** The visual graph is a
   disposable authoring surface that _compiles to code a developer keeps_. The
   canvas is the source of truth; the code is a build artifact (like a compiler).
2. **Agent-native, not automation-native.** First-class primitives for LLM agent
   patterns — autonomous tool-use loops, semantic routing, evaluator–optimizer,
   parallel orchestrator–workers — not HTTP nodes with AI bolted on.
3. **One IR, two authoring modes.** Drag-to-build and describe-to-build both
   emit the same `WorkflowGraph` IR, which compiles to the same code.

**Positioning:** NOT "open-source n8n." Position as _"the visual layer for the
agent SDK"_ / _"Figma-to-code for AI agents."_ Never compete on integration count.

## 3. Users & jobs

- **Builder (non-technical):** describe or drag to assemble an agent; tweak node
  settings through friendly forms; never sees raw JSON.
- **Developer (owner):** takes the generated code, owns it in their repo, edits
  and ships it. Cares that the code is idiomatic and the SDK is real.

---

## 4. Layout — three zones + a code drawer

A single full-viewport app. One CSS grid:
`topbar / [palette | canvas | inspector] / code-drawer`.

- **Left — Node Palette.** Collapsible. Search box at top. Draggable node types
  grouped by category (list in §6). Each item shows a **friendly name + a mono
  technical subtitle** (e.g. "Ask the AI" / `llm`). Drag onto canvas or
  double-click to insert.
- **Center — Canvas.** Infinite dotted-grid canvas with pan + zoom. The main
  stage; give it the most space. Holds nodes and edges. Minimap, zoom controls,
  and a fit-to-view button in the corners.
- **Right — Inspector / AI, as tabs.**
  - _Inspector:_ friendly forms to edit the selected node's config. Never raw
    JSON. Short helper text under fields, sensible defaults.
  - _AI Assistant:_ a chat where the user describes intent and the assistant
    builds/edits the graph on the canvas.
- **Bottom — Code Drawer.** Collapsible, pinned to the bottom, styled like a real
  editor: filename tabs, line numbers, syntax highlighting. A toggle expands it
  to half-screen; it's also drag-resizable. A subtle **"Synced"** indicator
  pulses when the graph changes. Three tabs:
  - `workflow.ts` — the generated, owned code (the hero).
  - `workflow.graph.json` — the live IR.
  - `@airun/sdk` — the hand-written SDK type surface (read-only reference).

---

## 5. The canvas (interaction spec)

- **Pan:** drag empty canvas. **Zoom:** wheel, zoom-to-cursor. Shift-wheel pans
  horizontally. A content layer carries one `translate()/scale()` transform; the
  dotted grid is a `radial-gradient` background tracking the same x/y/zoom.
- **Nodes are cards:** a header (icon + name + category accent color), a compact
  body showing key config (an `llm` node shows its model chip + a prompt
  snippet), **input ports on the left edge, output ports on the right edge.**
- **Two visually distinct edge types (essential):**
  - **Control flow** = execution order ("what runs next"): a solid line in the
    primary accent with a subtle animated flow.
  - **Data flow** = values passed between nodes: a thinner dashed line in a cool
    teal, with a tiny type label on hover (`string`, `json`, `messages`…).
- **Manual wiring:** drag from an output port → a rubber-band edge follows the
  cursor → drop on a compatible input port to create the edge. **While
  connecting, only valid targets light up** (same kind, opposite direction, no
  self-loops, no duplicates) and incompatible nodes dim. `Esc` cancels.
- **Edit affordances:** hovering a node highlights its connected edges and dims
  the rest; selected node gets a glowing accent ring; hovering an edge shows a
  small × at its midpoint to delete it. `Delete` removes the selected node.
- **Springy node entrance** when created or built by the assistant.

---

## 6. Node palette (friendly name · `technical type`)

Grouped, color-coded. Friendly names for non-technical users; mono technical
subtitle on each. These map to real SDK primitives (§9).

- **Triggers (green):** When something happens · `trigger`
- **AI (purple):** Ask the AI · `llm` — AI Agent (works on its own with tools) ·
  `agentLoop` — Smart Router (sends down different paths) · `router`
- **Tools (blue):** Connect a tool / API · `tool`
- **Logic (amber):** If / then · `conditional` — Repeat · `loop` — Do several at
  once · `parallel` — Reshape data · `transform`
- **Human (pink):** Get approval · `humanApproval` — Ask a person · `humanInput`
- **Memory & Output (slate):** Remember / recall · `state` — Send result out ·
  `output` — Use another workflow · `subworkflow`

### Inspector forms (examples of the "friendly, guided" bar)

- **Ask the AI (`llm`):** model dropdown (Claude models); system prompt with a
  **Static / Dynamic** toggle (dynamic shows a textarea with clickable
  `{{variable}}` chips that insert); user prompt; available-tools multi-select.
- **AI Agent (`agentLoop`):** model; plain-language goal; tools multi-select;
  a **"stop when…"** selector (max steps / a tool returns / the AI decides).
- **Smart Router (`router`):** a list of named routes each with a plain-language
  description; **adding a route adds an output port to the node on the canvas.**
- **Get approval (`humanApproval`):** the message shown to the approver, a
  timeout, and what happens on timeout (escalate / auto-approve / reject).

---

## 7. AI Assistant (the differentiator)

A chat panel. The user types intent in plain language; the assistant **builds the
graph on the canvas** — placing connected, pre-configured nodes that animate into
place already wired — and explains what it did in one or two sentences. It can
also **edit** an existing graph ("make it also log the question" → adds/rewires
nodes). For a prototype, the assistant responses are scripted/canned for known
prompts; that's fine — prioritize the _feel_ of intent → built graph.

Ship a set of one-click starter prompts that each build a complete, realistic
workflow (see §8).

---

## 8. Pre-loaded demos (don't start with an empty canvas-only feel)

Open on a near-empty canvas (a single trigger) so the AI-build moment leads.
Provide these as one-click quick-actions, each a real agent pattern:

1. **E-commerce support agent** — trigger → Smart Router (product question /
   order status / other) → catalog tool → answer LLM · order agent · human
   handoff → single output. (router + tool + agent + human)
2. **Parallel research assistant** — planner LLM → parallel fan-out to 3 research
   agents (web tools) → synthesizer (Opus) → cited report. (orchestrator–workers)
3. **Self-revising content pipeline** — outline → draft → quality gate that
   **loops back** to revise until it passes → editor approval → publish.
   (prompt chaining + evaluator–optimizer)
4. **Invoice approval** — OCR tool → normalize transform → $5k threshold gate →
   finance approval → post to ledger → audit log. (deterministic routing)
5. **Website builder agent** — brief → plan sitemap → parallel (copy agent /
   design tokens LLM / image agent) → assemble site (Opus) → preview approval →
   deploy → save → return URL.

Each demo must wire **both** edge types so both styles are always visible.

---

## 9. The architecture (two assets everything hangs off)

### A. The IR — `WorkflowGraph`

A plain-JSON contract that the editor _emits_. It is the public, documented
contract; design it as a product surface, not an internal blob.

```ts
WorkflowGraph {
  id, name, version,
  nodes: Array<{
    id, type, label,
    layout: { x, y },                      // ignored by codegen — view only
    ports: Array<{ id, kind:'control'|'data', direction:'in'|'out',
                   name, dataType? }>,
    config: <type-specific>,               // uses Binding for value fields
  }>,
  edges: Array<{ id, kind:'control'|'data',
                 from:{nodeId,portId}, to:{nodeId,portId}, dataType? }>,
  variables: Array<{ name, dataType, scope }>,
  metadata,
}
```

**Contract rules learned the hard way — bake these in:**

- **Derived vs authored ports.** A router's outputs are _derived_ from its routes
  config, not hand-authored. Give each route a **stable `id`**; edges reference
  the route `id`, never its display label (renaming a route must not orphan
  edges).
- **Typed bindings, not stringly-typed refs.** A config value is a `Binding`:
  `{kind:'literal', value}` | `{kind:'ref', nodeId, path}` |
  `{kind:'template', segments:[...]}`. Parse `{{var}}` templates into
  segments of literals + refs so every reference is validatable and renamable.
  Avoid two ways to express a literal.
- **DAG for data, cycles allowed for control.** Topo-sort over the **data-flow**
  graph (must be acyclic). **Control-flow** edges may cycle — those become
  `while`/`for`/bounded retry loops. State this invariant explicitly.
- **`version` on the graph** so codegen can branch and migrations are possible.

### B. The compiler — `IR → code`

A **per-node-type emitter registry** + a **control-flow walker**. Each node type
maps to exactly one SDK primitive. Emitters are pure: `(node, ctx) → string`.
An `EmitContext` provides stable identifier names, a `resolve()` for bindings,
back-edge (cycle) detection, and a collected import set. The walker handles:
router → `switch` or an `if`-diamond that reconverges at the join node;
parallel → `step.parallel([...])`; back-edge → a bounded revise loop;
linear chain → sequential `await`s. Keep `layout` out of codegen entirely.

### C. The SDK surface — `@airun/sdk` (PART B)

Hand-written **once**; the editor never generates it. Each node type → one
primitive. This is the actual product moat — the generated file is only as good
as the SDK it builds on. The surface (illustrative):

```ts
trigger        -> onEvent / onSchedule / onWebhook          // the `on:` field
tool           -> tool.http / tool.fn
transform      -> step.transform
router         -> step.route   (deterministic predicates)
router (LLM)   -> ai.classify  (semantic routing)
llm            -> ai.generate
agentLoop      -> ai.agent      // the whole tool-use loop, hidden inside the SDK
parallel       -> step.parallel
conditional    -> if / else
loop           -> step.forEach / step.while
humanApproval  -> step.approval // durable; the wait survives restarts
humanInput     -> step.input
state          -> state.get / set / append
subworkflow    -> step.invoke
```

A workflow compiles to a single `defineWorkflow({ id, on, run })` whose `run`
receives `{ event, step, ai, state }`. The SDK primitives are thin: each durable
operation delegates to the `RuntimeAdapter` bound for the current run, so **the
agent loop, durability, retries, and approvals live in `@airun/runtime`, not in
generated code** (the SDK exposes the contract; the runtime installs the
implementation via `installRuntimeResolver`). That separation — not raw
`messages.create` calls in user code — is the single biggest reason to ship an
SDK. Factories that run at module-load time (`tool.*`, `state`, `trigger`) return
descriptors/handles whose operations delegate at call time, so a top-level
`const t = tool.http(...)` is inert until `await t(...)` runs inside a workflow.

### D. The runtime — `@airun/runtime` (durable execution)

The SDK is the thin authoring surface; **`@airun/runtime` is what actually
executes it** — and it is the hard 90% that makes "owned code" more than a toy.
This is built **for real, not faked**: it is the closest analogue to
trigger.dev / Inngest / Temporal in this project.

- **Durable by design.** A **step journal** records every completed step's
  result. On restart the workflow is replayed, but completed steps are served
  from the journal instead of re-executing — so side effects fire once, state
  mutates once, and `step.approval` / `step.input` waits survive restarts for
  free. Suspension is a replay model: an unresolved wait throws, the run reports
  its pending waits, and `resume()` re-runs from the top with the wait's result
  now journaled.
- **One journal, two payoffs.** The same journal is the source of truth for
  durability **and** for the **live-run / observability traces** (see §14).
- **Self-host first.** A single-node runtime that genuinely works self-hosted is
  the open-source core. The multi-tenant managed scheduler is the commercial
  layer and lives in a private repo (see §15).

**v1 status.** The engine is implemented: `AsyncLocalStorage`-bound run context,
deterministic step keys, the durable-step memoizer, the agent loop with
`stopWhen`, state ops, and approval/input suspension. The journal sits behind a
`Journal` **port** with two interchangeable implementations: an in-memory store
(the canonical choice for dev + tests) and a **Postgres adapter** (`postgresJournal`,
over a driver-agnostic `Queryable` surface that a `pg.Pool` satisfies; values are
stored under a jsonb envelope and `ensureSchema()` provisions the tables).
External effects are ports too — `ModelClient` (a deterministic stub by default,
with a real **Anthropic adapter**, `anthropicModelClient`, shipping alongside it),
`HttpClient` (global `fetch`), and `SecretResolver` (env-backed; **secrets are
resolved at call time, never inlined**). The journal also records an append-only
**trace event stream** (run lifecycle + per-step timings, status, payloads);
`createRuntime` accepts an optional live `onTrace` sink, and `trace(runId)`
assembles the stored events into a `RunTrace` timeline (§14). Replayed steps are
served from the journal and **not** re-traced, so a trace reflects real work
once. Entry points: `createRuntime(deps?)` → `{ run, resume, trace }`.

---

## 10. Visual style

Follow `DESIGN.md` exactly. Summary: confident dev-tool dark mode (Linear /
Vercel / Raycast); a stack of near-black surfaces with hairline borders; one
electric indigo-violet accent used sparingly; muted category colors that carry
meaning; Geist for UI, Geist Mono for all identifiers and code; springy short
motion with exactly one ambient loop (the control-edge flow); no gradient
washes, no emoji, no slop. Everything visual is a CSS token.

---

## 11. Tech

- **Monorepo: Turborepo + yarn workspaces**, npm scope `@airun`. Package and app
  layout is specified in §13.
- **Canvas: React Flow** (customized to honor the two-edge visual contract and
  valid-target highlighting from §5 / `DESIGN.md` — never accept its defaults).
  Real syntax highlighting in the drawer.
- **Execution is real, not mocked.** Workflows run on `@airun/runtime` (§9D).
  The visual builder's _AI Assistant_ may still be scripted/canned in v1 (§7),
  but the SDK and runtime are genuine from the start.
- Keep the codebase split by concern (one file per feature; see `DESIGN.md` §5).
  New node type = three small edits: registry entry + emitter + inspector form.

---

## 12. Suggested build order (milestones)

1. **Shell + tokens.** App grid, topbar, empty panels, the full `:root` token
   set, fonts. Get `min-height:0` right so the drawer never blows out.
2. **Canvas core.** Pan/zoom/grid, render hard-coded nodes, selection, drag.
3. **Edges.** Both edge types with the hard visual distinction; hover highlight.
4. **Node registry + palette + inspector** for 3–4 node types end to end.
5. **The IR + compiler + code drawer.** Emit `WorkflowGraph`, compile to
   `@flow/sdk` source, show all three tabs with the synced pulse.
6. **Manual wiring** (ports, rubber-band, valid-target highlighting, delete).
7. **AI Assistant** with the canned build scripts + the 5 demo workflows.
8. **Polish:** minimap, fit-to-view, toasts, entrance animations, reduced-motion.

### What to get right vs. skip

- **Get right:** the two-edge visual contract; the live code/IR sync; the
  IR→code compiler architecture; the friendly-name/technical-subtitle duality;
  manual wiring with valid-target highlighting; **the durable runtime + step
  journal** (it's the moat — see §9D).
- **Fine to fake in v1:** assistant intelligence (scripted), auth, multi-tenant
  cloud, real third-party integrations.
- **No longer faked:** execution. Real runs go through `@airun/runtime`, and
  live-run visualization (§14) is now a core part of the story, not an
  afterthought.

---

## 13. Monorepo & packages

**Turborepo + yarn workspaces.** npm scope `@airun`. Two principles drive the
split: (1) the **IR, compiler, and SDK are independent packages** everything
hangs off; (2) what we open-source must work self-hosted, what we charge for
(the multi-tenant cloud) lives in a **separate private repo** (§15).

### Published to npm (public, Apache-2.0)

| Package | Purpose |
|---|---|
| `@airun/sdk` | The hand-written primitive surface (`defineWorkflow`, `ai.*`, `step.*`, `state.*`, `tool.*`). What a developer imports and owns. The moat. |
| `@airun/schema` | The `WorkflowGraph` IR — types + zod validators + `Binding` + `version`/migrations. The public contract (the `flow.schema.ts` of §9A). |
| `@airun/compiler` | `IR → code`. Per-node-type emitter registry + control-flow walker + `EmitContext`. Pure. |
| `@airun/node-registry` | Canonical node-type list: categories, port geometry, icons, defaults, config schemas. Shared by builder and compiler. |
| `@airun/runtime` | Durable execution engine (§9D): step journal, agent loop, retries, approvals, state, traces. Self-host core. |
| `@airun/client` | Client for the runtime/cloud API — trigger runs, stream traces. Used by live-run and the dashboard. |
| `@airun/flow-builder` | The **embeddable** visual builder as a React component (canvas + nodes + palette + inspector + code drawer). |
| `@airun/cli` | `airun` CLI — compile `*.graph.json` → code in CI, run locally, deploy. |
| `@airun/eval` *(later)* | Eval primitive/runner (LLM-as-judge, assertions). |

### Not published (`"private": true`)

- `apps/builder` — standalone app wrapping `@airun/flow-builder`.
- `apps/dashboard` — observability / run-monitoring app (§14).
- `apps/docs` — docs site.
- `@airun/tsconfig`, `@airun/eslint-config`, optional internal `@airun/ui`
  (design tokens) — shared tooling.
- `cloud/api` — the multi-tenant managed backend; lives in a **separate private
  repo**, not this one.

### Dependency direction (no cycles)

`schema` ← everything. `compiler` → `schema` + `node-registry`.
`runtime` → `sdk` + `schema`. `flow-builder` → `node-registry` + `compiler` +
`client` + `ui`. `sdk` depends on nothing (publishes standalone).

### Recommended build order (packages)

`@airun/schema` → `@airun/sdk` → `@airun/runtime` (durable, emitting traces) →
then the canvas (`@airun/flow-builder`) on top of the finished contract. The
milestone list in §12 is the UI track; this is the platform track underneath it.

---

## 14. Live-run & observability (trigger.dev-style)

The emotional peak of the story — *describe it → see it built → **watch it run**
→ own the code.* Two surfaces, both reading off the runtime's step journal (§9D):

- **Live-run in the builder.** A "Run" with a user-supplied prompt/input streams
  execution **through the graph itself**: the active node pulses, data animates
  along edges, and each node shows its real input/output payload on hover.
  This is canvas-native time-travel debugging, not a flat log.
- **Observability dashboard (`apps/dashboard`).** Your SDK executes, and you can
  watch *how* it ran: run history, traces, step timings, retries, payloads —
  the trigger.dev-style operator view. Retention/scale here is a paid axis (§15).

**Substrate status.** The runtime side is implemented: every run emits an
append-only trace event stream into the journal (`run.started/resumed/suspended/
completed/failed` and per-step `started/completed/failed` with timings, status and
payloads). `createRuntime({ onTrace })` streams events live as they happen (for the
canvas pulse), and `runtime.trace(runId)` folds the stored stream into a `RunTrace`
timeline for the dashboard. Both surfaces read this one source of truth.

**Canvas status.** Phase A of the visual builder now exists. `@airun/node-registry`
carries the canonical node-type metadata (category + hue, friendly name + technical
subtitle, icon, static port geometry, default config) and a `derivePorts(node)` that
materializes the dynamic ports the IR leaves implicit (`route:*`, `branch:*`,
`branch:else`, `approved`/`rejected`, `error`, `fields.*`). `@airun/flow-builder`
renders a `WorkflowGraph` on a React Flow canvas honoring the two-edge contract
(control = solid accent with an animated dashed overlay; data = thin teal dashes with
a hover type-label) plus a searchable, category-grouped palette; `apps/builder` is the
standalone Vite app that mounts it on the invoice demo. Phase B adds live editing:
palette items drag onto the canvas to create nodes (via the registry's `createNode`),
ports connect by drag, and selection + Delete removes. A single connection rule set —
mirroring the IR edge invariants: the local pairwise check (`canConnect`:
control↔control / data↔data, out→in, no self, compatible data types, no duplicate)
plus the graph-global acyclicity check (`wouldFormCycle`: the data subgraph stays a
DAG, and control flow may only cycle back through a loop node's `continue` port) —
drives both React Flow's `isValidConnection` (snap + drop refusal) and the live port
highlighting (valid targets light up, the source pulses, everything else dims), so
what lights up is exactly what can be dropped. Phase C adds the inspector: the canvas
now carries the full IR node in each React Flow node (so it can round-trip a
`WorkflowGraph`, not just a view model), and selecting a node opens a per-type form
that renames it and edits its **literal** scalar config (model, prompt, mode, numeric
bounds, …). Config values are `Binding`s, and every `Bound` field carries a source
switcher — `literal`, `ref` (another node's output + optional dot-path), `var` (a
declared workflow variable), or `template` (text + nested-binding segments); the ref/var
pickers draw their candidates from a `BindingContext` the canvas supplies (other nodes +
declared variables). List config is editable too: add / remove / rename router routes,
conditional branches, and human-input fields. Edits re-derive the node's ports and prune
any edge whose endpoint port no longer exists, so the matching `route:*` / `branch:*` /
`fields.*` port appears or disappears on the canvas at once. Router routes and
conditional branches carry a recursive condition editor (`compare` / `and` / `or` /
`not` / unsafe `expr`) over the IR `Condition`, with each `compare` operand reusing the
same binding-source switcher — this completes Phase C.
Phase D adds the live code drawer: a `flowToGraph` reverse adapter folds the canvas
back into a `WorkflowGraph` (refreshing only `layout` from live positions — never read
by codegen), and the footer drawer shows the owned `workflow.ts` (`compileWorkflow`)
and the `workflow.graph.json` serialization, recomputed as the canvas changes. A graph
that fails validation shows the offending invariants instead of code, and a
not-yet-supported node type surfaces the compiler's `CompileError`, so the drawer is
also live validation. Both panes are syntax-highlighted with Shiki (fine-grained core,
the WASM-free JavaScript regex engine, only the `typescript`/`json` grammars + one dark
theme), dynamically imported on first open so it splits into its own chunk and never
weighs down the initial bundle.
Phase E (slice 1) adds the live-run overlay. `@airun/client` now ships its typed surface
(`RunClient`/`RunHandle`), the observability wire contract (`TraceEvent`/`RunTrace`/`StepTrace`
+ an incremental `reduceTrace` reducer, mirroring the runtime's internal trace shape), and a
browser-side `createMockRunClient` that fabricates a plausible trace from a graph — walking it
in control-flow order from the trigger and keying each step by node id. The builder's topbar
Run button drives it: a `RunContext` folds the streaming events into per-node status so each
card paints a running/done/failed ring (idle nodes dim), and a floating trace panel logs the
steps. The run is simulated by design — the runtime is Node-only (`AsyncLocalStorage`) so it
can't execute in the browser, and there's no server; the same `RunClient` interface will back a
real HTTP/SSE client when a runtime server lands. Step-key→node mapping is exact only for the
mock (it keys by node id); a real run keys steps as `label#ordinal`, so node-level highlighting
against the real runtime needs a codegen sourcemap — a follow-up.
Still to come: the real run-server + HTTP/SSE client, and node-level highlighting for real runs.

---

## 15. Licensing & monetization

- **License: Apache-2.0** on the SDK, builder, compiler, IR, and runtime —
  maximize adoption and trust. The multi-tenant cloud/billing is kept in a
  **separate private repo** so the license question never blocks the open core.
- **Model: open-core + managed cloud**, usage-based billing on **runs/compute**
  (never per node/workflow — that would penalize adoption).
- **Free / OSS (must genuinely work self-hosted):** `@airun/sdk`, the visual
  builder, compiler, IR, CLI, single-node `@airun/runtime`, and a single-user
  local observability dashboard.
- **Paid (what teams don't want to operate themselves):** managed durable
  execution (scaling, queues, retries, approvals surviving restarts),
  observability at scale (trace retention, search, time-travel), concurrency /
  throughput tiers, team features (environments dev/staging/prod, RBAC,
  SSO/SAML, audit log, managed secrets), and evals at scale.
