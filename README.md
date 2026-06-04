# AIRun

**The visual layer for the agent SDK — Figma-to-code for AI agents.**

Build LLM/agent workflows by dragging nodes on a canvas or describing them in
plain language. Both authoring modes emit the same `WorkflowGraph` IR, which
compiles to **real, idiomatic TypeScript you own** on top of `@airun/sdk` — and
runs on a **durable runtime** you can watch execute, node by node.

> Not "open-source n8n." The canvas is a disposable authoring surface; the code
> is the product. See [`docs/AIRun-workflow-builder_description.md`](docs/AIRun-workflow-builder_description.md).

## Quick start

Requirements: **Node ≥ 18** and **Yarn 3.5.1** (pinned via `packageManager`; Corepack
will use the right version automatically — run `corepack enable` once if needed).

```bash
yarn install      # install all workspace deps
yarn build        # compile every package (turbo orders them by dependency)
yarn test         # run the test suites (compiler + runtime)
yarn typecheck    # type-check everything
```

`yarn build` must succeed before `test`/`typecheck` — those tasks `dependsOn ^build`,
and most packages consume the built `dist/` of their workspace dependencies.

### Run the visual builder

The `builder` app is a standalone Vite app that mounts `@airun/flow-builder` on a
demo graph. After `yarn install && yarn build`:

```bash
yarn workspace @airun/builder dev
```

Open <http://localhost:5173>. You get the canvas loaded with the bundled invoice
example: drag nodes from the palette, connect ports, edit config in the inspector,
and open the footer drawer to watch the **owned `workflow.ts`** regenerate live as
you edit. (The demo graph is wired in `apps/builder/src/main.tsx` — swap
`invoiceGraph` for `landingGraph`, `contentPipelineGraph`, or `crmAssistantGraph`
from `@airun/schema/examples` to try the others.)

## How it fits together

```
canvas / prompt  ──►  WorkflowGraph IR  ──►  owned TypeScript  ──►  durable run
 @airun/flow-builder    @airun/schema       @airun/compiler        @airun/runtime
                                              → @airun/sdk surface
```

The **IR + compiler** are the two load-bearing assets: a canvas-authored graph is
validated against `@airun/schema`, then `@airun/compiler` walks it from the trigger
and emits a `defineWorkflow({...})` module on the hand-written `@airun/sdk` surface.
The generated file is the deliverable — you own and commit it; there is no hidden
runtime interpreting your graph.

## Monorepo layout

Turborepo + Yarn workspaces. npm scope `@airun`. ESM only.

### Packages (`packages/*`) — published, Apache-2.0

| Package | Status | Purpose |
|---|---|---|
| `@airun/schema` | ✅ | `WorkflowGraph` IR — types, zod validators, `Binding`, versioning. The public contract. |
| `@airun/sdk` | ✅ | Hand-written primitive surface (`defineWorkflow`, `ai.*`, `step.*`, `state.*`, `tool.*`). |
| `@airun/compiler` | ✅ | `IR → code`. Control-flow walker + per-node emission. |
| `@airun/node-registry` | ✅ | Canonical node-type list: categories, ports, icons, config schemas. |
| `@airun/runtime` | ✅ | Durable execution engine: step journal, agent loop, retries, approvals, traces. |
| `@airun/client` | ✅ | Client for the runtime/cloud API — trigger runs, stream traces. |
| `@airun/flow-builder` | ✅ | Embeddable visual builder (React component). |
| `@airun/cli` | 🚧 | `airun` CLI — compile, run, deploy. _(stub)_ |
| `@airun/eval` | 🚧 | Eval primitive/runner. _(planned)_ |

### Apps (`apps/*`) — private, not published

| App | Status | Purpose |
|---|---|---|
| `builder` | ✅ | Standalone visual builder wrapping `@airun/flow-builder`. |
| `dashboard` | 🚧 | Observability / run-monitoring (trigger.dev-style). _(stub)_ |
| `docs` | 🚧 | Documentation site. _(stub)_ |

### Tooling (`tooling/*`) — private

`@airun/tsconfig`, `@airun/eslint-config` — shared config.

## Documentation

- [`docs/AIRun-workflow-builder_description.md`](docs/AIRun-workflow-builder_description.md) — product spec: IR shape, compiler design, SDK surface mapping, runtime, build order.
- [`docs/design-guide.md`](docs/design-guide.md) — visual + code-style rules for the canvas/UI.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to develop, test, and submit changes.

## License

[Apache-2.0](LICENSE). The multi-tenant managed cloud lives in a separate
private repo.
