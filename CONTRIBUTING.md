# Contributing to AIRun

Thanks for helping build AIRun (product name **Flowsmith**). This guide covers how
to get the repo running, the conventions we follow, and how to ship a change.

Read [`CLAUDE.md`](CLAUDE.md) alongside this file — it is the canonical statement of
the architecture and the non-negotiable invariants. This guide is the practical
"how to work in the repo" companion.

## Prerequisites

- **Node ≥ 18** (we test on current LTS).
- **Yarn 3.5.1** — pinned via the `packageManager` field. Enable Corepack once so the
  correct Yarn is used automatically:
  ```bash
  corepack enable
  ```

## Getting started

```bash
git clone <your-fork-url>
cd AIRun-workflow-builder
yarn install
yarn build        # builds all packages in dependency order (turbo)
yarn test         # compiler + runtime test suites (vitest)
```

That four-line sequence is the baseline: if `install → build → test` is green, your
checkout is healthy.

### Running things

All commands run from the repo root; [Turborepo](https://turbo.build) fans them out
across workspaces in the right order.

| Command | What it does |
|---|---|
| `yarn build` | Build every package (`tsc` / `vite`). |
| `yarn typecheck` | Type-check everything (`dependsOn ^build`). |
| `yarn test` | Run all test suites (currently `@airun/compiler` + `@airun/runtime`). |
| `yarn lint` | Run linting across workspaces. _(no package wires a lint task yet — shared config lives in `@airun/eslint-config`.)_ |
| `yarn dev` | Start every package's watch task. |
| `yarn clean` | Remove `dist/`, `.turbo/`, and `node_modules`. |

To run a single workspace, use `yarn workspace <name> <script>`, e.g.:

```bash
yarn workspace @airun/compiler test       # just the compiler tests
yarn workspace @airun/builder dev         # the visual builder at :5173
```

### The visual builder

`apps/builder` mounts `@airun/flow-builder` on a demo graph. After a full `yarn build`:

```bash
yarn workspace @airun/builder dev
```

Then open <http://localhost:5173>. The demo graph is selected in
`apps/builder/src/main.tsx`; swap `invoiceGraph` for any export from
`@airun/schema/examples` (`landingGraph`, `contentPipelineGraph`, `crmAssistantGraph`)
to exercise a different shape.

## Architecture in one paragraph

A canvas-authored **`WorkflowGraph` IR** (`@airun/schema`) is validated, then
**`@airun/compiler`** walks it from its trigger and emits a `defineWorkflow({...})`
module on the hand-written **`@airun/sdk`** surface. That generated TypeScript is the
deliverable — you own it — and it executes on the durable **`@airun/runtime`**. The IR
and the compiler are the two load-bearing assets; everything else builds on them.

**Build order** (handled automatically by turbo's `^build`): `schema` → `sdk` →
`compiler` / `node-registry` / `runtime` → `client` / `flow-builder` / `cli` → apps.

## Code style — non-negotiable

These mirror [`CLAUDE.md`](CLAUDE.md); the short version:

- **ESM only.** Import specifiers use explicit `.js` extensions. `moduleResolution`
  is `Bundler`; `verbatimModuleSyntax` and `isolatedModules` are on.
- **`strict` + `noUncheckedIndexedAccess`** are globally on — don't disable them.
- **No `any`.** Use `unknown` and narrow.
- **No `enum`.** Use `as const` objects with `keyof typeof` (`const enum` is banned by
  `isolatedModules`).
- `type` for shapes, `interface` for extendable contracts. Discriminated unions over
  boolean-flag soup. Branded IDs for identifiers.
- **Explicit return types** on every exported function; exported async functions name
  their `Promise<T>`.
- **SOLID / KISS / DRY**, but don't abstract until a second real caller exists.
- **Surgical changes.** No drive-by refactors, renames, or reformatting bundled into a
  feature change.

### Security invariants (will block a PR)

- **Secrets are NEVER inlined** into generated code. The compiler emits
  `auth: { secret: "NAME" }`-style references; the `SecretRef` is resolved at runtime.
- **`layout` never affects codegen.** Node coordinates are purely visual — the compiler
  must produce identical output regardless of layout.
- Never commit secrets or credentials.

## Testing

Tests use [vitest](https://vitest.dev) and live in each package's `test/` directory
(today: `@airun/compiler`, `@airun/runtime`). When you change the compiler or the IR:

- Add a **round-trip test** — compile a graph fixture and assert on the emitted code.
  See `packages/compiler/test/compile.test.ts` for the `graph()` / `ctl()` builders and
  the example-graph round-trips.
- Compiler tests import the example fixtures from the **built** schema
  (`../../schema/dist/examples/*.js`), so run `yarn build` (or at least build `schema`)
  before `yarn test` after editing a fixture.

## Keep docs in sync

After every serious feature, **update [`docs/`](docs/) or the relevant README in the
same change.** A feature is not done while the docs still describe the old behavior.
The authoritative docs are:

- [`docs/AIRun-workflow-builder_description.md`](docs/AIRun-workflow-builder_description.md) — product/architecture spec.
- [`docs/design-guide.md`](docs/design-guide.md) — canvas/UI visual + code-style rules.

## Submitting a change

1. Branch off `main`.
2. Make the change, keeping it surgical and tied to a single goal.
3. Run the gate locally: `yarn build && yarn typecheck && yarn test`.
4. Update docs in the same change if behavior changed.
5. Open a PR with a clear description of **why** (not just what). Reference any related
   issue.

Commit messages: short imperative subject (`add`, `update`, `fix`, `refactor`), with the
"why" in the body when it isn't obvious.

## Troubleshooting

- **`Cannot find module '@airun/schema'` (or another `@airun/*`) during build/typecheck.**
  Usually a stale incremental-build artifact left a package's `dist/` partially emitted, so
  dependents can't resolve it. Clear the caches and rebuild:
  ```bash
  find packages -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
  rm -rf packages/*/dist packages/*/.turbo .turbo
  yarn build
  ```
- **Turbo replays a cached "success" but output is missing.** Force a fresh run with
  `yarn turbo run build --force`.
- **Wrong Yarn version.** Run `corepack enable`; the repo pins `yarn@3.5.1`.

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0](LICENSE) license.
