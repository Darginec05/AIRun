# AIRun

**The visual layer for the agent SDK — Figma-to-code for AI agents.**

Build LLM/agent workflows by dragging nodes on a canvas or describing them in
plain language. Both authoring modes emit the same `WorkflowGraph` IR, which
compiles to **real, idiomatic TypeScript you own** on top of `@airun/sdk` — and
runs on a **durable runtime** you can watch execute, node by node.

> Not "open-source n8n." The canvas is a disposable authoring surface; the code
> is the product. See [`docs/AIRun-workflow-builder_description.md`](docs/AIRun-workflow-builder_description.md).

## Monorepo layout

Turborepo + yarn workspaces. npm scope `@airun`.

### Packages (`packages/*`) — published, Apache-2.0

| Package | Purpose |
|---|---|
| `@airun/sdk` | Hand-written primitive surface (`defineWorkflow`, `ai.*`, `step.*`, `state.*`, `tool.*`). |
| `@airun/schema` | `WorkflowGraph` IR — types, zod validators, `Binding`, versioning. The public contract. |
| `@airun/compiler` | `IR → code`. Per-node emitter registry + control-flow walker. |
| `@airun/node-registry` | Canonical node-type list: categories, ports, icons, config schemas. |
| `@airun/runtime` | Durable execution engine: step journal, agent loop, retries, approvals, traces. |
| `@airun/client` | Client for the runtime/cloud API — trigger runs, stream traces. |
| `@airun/flow-builder` | Embeddable visual builder (React component). |
| `@airun/cli` | `airun` CLI — compile, run, deploy. |
| `@airun/eval` | Eval primitive/runner. _(planned)_ |

### Apps (`apps/*`) — private, not published

| App | Purpose |
|---|---|
| `builder` | Standalone visual builder wrapping `@airun/flow-builder`. |
| `dashboard` | Observability / run-monitoring (trigger.dev-style). |
| `docs` | Documentation site. |

### Tooling (`tooling/*`) — private

`@airun/tsconfig`, `@airun/eslint-config` — shared config.

## Status

Scaffolding only. Package implementations are not started yet.

## Develop

```bash
yarn install
yarn build      # turbo run build
yarn dev        # turbo run dev
yarn typecheck
```

## License

[Apache-2.0](LICENSE). The multi-tenant managed cloud lives in a separate
private repo.
