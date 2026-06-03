// @airun/compiler — IR → TypeScript on @airun/sdk.
//
// compileWorkflow(graph) walks the control-flow graph from the trigger and emits
// a `defineWorkflow({...})` module on the @airun/sdk surface. See compile.ts for
// the walker and per-node-type emission rules.

export * from "./compile.js";
