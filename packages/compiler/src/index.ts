// @airun/compiler — IR → TypeScript on @airun/sdk.
//
// A per-node-type emitter registry (pure: (node, ctx) => string) plus a
// control-flow walker: router → switch/if-diamond, parallel → step.parallel,
// back-edge → bounded loop, linear → sequential awaits. EmitContext supplies
// stable identifiers, resolve() for bindings, cycle detection, import set.
// Topo-sort runs over the data-flow graph (acyclic); control edges may cycle.
// Implementation not started yet.

export {};
