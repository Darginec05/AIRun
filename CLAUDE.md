# CLAUDE.md

Guidance for working in this repository. Read this before making changes.

## What this is

AIRun (product name **Flowsmith**) is an open-source visual workflow builder for AI agents. A canvas-authored **WorkflowGraph IR** compiles down to plain, owned TypeScript that runs on the `@airun/sdk` surface — the generated code is the deliverable, not a hidden runtime.

- Turborepo + yarn workspaces (`yarn@3.5.1`), npm scope `@airun`, Apache-2.0.
- ESM only. Import specifiers use explicit `.js` extensions; TS is configured with `moduleResolution: Bundler`, `verbatimModuleSyntax`, `isolatedModules`, `strict`, `noUncheckedIndexedAccess`.

### Core packages

- `@airun/schema` — the v1 `WorkflowGraph` IR and zod validators. This is the contract; treat it as the source of truth.
- `@airun/sdk` — the declare-only authoring surface the compiler targets (`defineWorkflow`, `ai`, `step`, `tool`, `state`, `event`, `trigger`, `Schema`).
- `@airun/compiler` — IR → TypeScript. A control-flow tree-walker over the graph from its trigger.

The IR + compiler are the two load-bearing assets. Other packages (`cli`, `client`, `runtime`, `node-registry`, `eval`, `flow-builder`) build on top.

## Docs — keep them consistent

Authoritative docs live in [`@docs/`](docs/):

- [`@docs/AIRun-workflow-builder_description.md`](docs/AIRun-workflow-builder_description.md) — product spec: IR shape, compiler design, SDK surface mapping, runtime, package list, build order, licensing.
- [`@docs/design-guide.md`](docs/design-guide.md) — visual + code-style rules for the canvas/UI (the two-edge visual contract, valid-target highlighting, etc.).

**After every serious feature, update `@docs/` or the relevant `README` in the same change** so that code and documentation stay consistent. A feature is not done while the docs still describe the old behavior.

## Workflow commands

Run from the repo root (turbo fans out across workspaces):

- `yarn build` — build all packages.
- `yarn typecheck` — typecheck all packages.
- `yarn test` — run tests (vitest in `@airun/compiler`).
- `yarn lint` — lint all packages.

The `test` task `dependsOn ^build`, so a typecheck/build pass is the baseline gate before reporting work as done.

## Working practices

- **Think before coding.** Understand the IR contract and the existing control-flow walk before editing. State the plan, then make the change — don't code-first and rationalize later.
- **Simplicity first.** Prefer the boring, direct solution. Add abstraction only when a second real caller exists, not in anticipation of one.
- **Surgical changes.** Touch the minimum needed to accomplish the task. No drive-by refactors, renames, or reformatting bundled into a feature change.
- **Goal-driven execution.** Tie every change back to the stated goal. When done, verify against it (typecheck/test/round-trip) rather than assuming success.

## Security & invariants — non-negotiable

- **Secrets are NEVER inlined** into generated code. A `SecretRef` is resolved at runtime; the compiler emits `auth: { secret: "NAME" }`-style references only.
- **`layout` never affects codegen.** Node coordinates are purely visual; the compiler must produce identical output regardless of layout.
- Never commit secrets or credentials.

## Code style — non-negotiable principles

When writing code, follow:

- **SOLID.** Single responsibility per class/module; depend on abstractions, not concretions; keep interfaces small and focused.
- **KISS.** Pick the boring solution. A `for` loop is not a sin. Avoid clever generics, premature abstractions, and speculative branches that aren't on a real roadmap.
- **DRY.** Extract when the same *idea* repeats in ≥2 places. Do not extract two-line snippets that merely look alike — accidental similarity is not duplication.
- **TypeScript best practices:**
  - `strict` mode and `noUncheckedIndexedAccess` are globally on. Don't disable them.
  - No `any`. If you truly need an escape, use `unknown` and narrow.
  - `type` for shapes, `interface` for extendable contracts.
  - `as const` for literal lookup tables; never magic strings.
  - Discriminated unions over boolean-flag soup.
  - No `enum`. Use `as const` objects with `keyof typeof` (`const enum` is banned by `isolatedModules`).
  - Branded ID types (`type UnitId = string & { readonly __brand: "UnitId" }`).
  - Explicit return types on every exported function.
  - Top-level imports only — no dynamic `require`.
  - All async code returns `Promise<T>` with `T` named explicitly on exports.
