// @airun/runtime — the durable execution engine (the hard 90%).
//
// A Postgres step journal records every completed step's result; on restart the
// workflow replays and completed steps are served from the journal instead of
// re-executing, so step.approval / step.input waits survive restarts. The same
// journal is the source of truth for live-run and observability traces.
// Single-node self-host core; the multi-tenant scheduler is a private repo.
// Implementation not started yet.

export {};
