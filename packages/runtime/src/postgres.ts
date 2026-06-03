// A Postgres-backed Journal — the durable substrate for self-hosting beyond a
// single process. It implements the same Journal port as InMemoryJournal, so the
// engine is unchanged: this is a drop-in adapter, not an engine edit.
//
// It depends on a minimal `Queryable` abstraction rather than the `pg` package,
// so the runtime stays driver-agnostic and dependency-free. A `pg.Pool`
// satisfies `Queryable` structurally — `postgresJournal(pool)` is the wiring.
//
// Values are stored under a `{ "v": <value> }` jsonb envelope so the journal can
// tell "recorded as undefined/null" (a row exists) from "absent" (no row) — the
// distinction StepLookup.found relies on.

import type { Journal, RunRecord, RunStatus, StepLookup } from "./journal.js";

/** A driver-agnostic query surface. `pg.Pool` and `pg.Client` both satisfy it. */
export interface Queryable {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS airun_runs (
  run_id text PRIMARY KEY,
  status text NOT NULL,
  input  jsonb,
  output jsonb
);
CREATE TABLE IF NOT EXISTS airun_steps (
  run_id   text NOT NULL,
  step_key text NOT NULL,
  result   jsonb,
  PRIMARY KEY (run_id, step_key)
);
CREATE TABLE IF NOT EXISTS airun_state (
  scope_key text NOT NULL,
  name      text NOT NULL,
  value     jsonb,
  PRIMARY KEY (scope_key, name)
);
`;

interface Envelope {
  v?: unknown;
}

/** Wrap a value for storage; `JSON.stringify` drops `undefined` to a `{}` envelope. */
function wrap(value: unknown): string {
  return JSON.stringify({ v: value });
}

/** Unwrap a jsonb envelope returned by Postgres (already parsed to an object). */
function unwrap(payload: unknown): unknown {
  return (payload as Envelope | null)?.v;
}

interface RunRow {
  status: RunStatus;
  input: unknown;
  output: unknown;
}

export class PostgresJournal implements Journal {
  constructor(private readonly db: Queryable) {}

  /** Create the journal tables if they do not exist. Safe to call repeatedly. */
  async ensureSchema(): Promise<void> {
    await this.db.query(SCHEMA);
  }

  async createRun(runId: string, input: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO airun_runs (run_id, status, input) VALUES ($1, 'running', $2::jsonb)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, wrap(input)],
    );
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const { rows } = await this.db.query<RunRow>(
      `SELECT status, input, output FROM airun_runs WHERE run_id = $1`,
      [runId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const record: RunRecord = { runId, status: row.status, input: unwrap(row.input) };
    if (row.output !== null && row.output !== undefined) record.output = unwrap(row.output);
    return record;
  }

  async setRunStatus(runId: string, status: RunStatus, output?: unknown): Promise<void> {
    if (output === undefined) {
      await this.db.query(`UPDATE airun_runs SET status = $2 WHERE run_id = $1`, [runId, status]);
      return;
    }
    await this.db.query(`UPDATE airun_runs SET status = $2, output = $3::jsonb WHERE run_id = $1`, [
      runId,
      status,
      wrap(output),
    ]);
  }

  async getStep(runId: string, stepKey: string): Promise<StepLookup> {
    const { rows } = await this.db.query<{ result: unknown }>(
      `SELECT result FROM airun_steps WHERE run_id = $1 AND step_key = $2`,
      [runId, stepKey],
    );
    const row = rows[0];
    return row ? { found: true, result: unwrap(row.result) } : { found: false, result: undefined };
  }

  async putStep(runId: string, stepKey: string, result: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO airun_steps (run_id, step_key, result) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (run_id, step_key) DO UPDATE SET result = EXCLUDED.result`,
      [runId, stepKey, wrap(result)],
    );
  }

  async getState(scopeKey: string, name: string): Promise<StepLookup> {
    const { rows } = await this.db.query<{ value: unknown }>(
      `SELECT value FROM airun_state WHERE scope_key = $1 AND name = $2`,
      [scopeKey, name],
    );
    const row = rows[0];
    return row ? { found: true, result: unwrap(row.value) } : { found: false, result: undefined };
  }

  async putState(scopeKey: string, name: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO airun_state (scope_key, name, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (scope_key, name) DO UPDATE SET value = EXCLUDED.value`,
      [scopeKey, name, wrap(value)],
    );
  }

  // append/merge are single-statement upserts: the conflict path reads and
  // rewrites the row's value atomically under its lock, so two concurrent runs
  // sharing a scope cannot lose each other's writes. `$3` seeds the row when
  // absent (from `initial`); `$4` is what the conflict path concatenates/merges.
  async appendState(scopeKey: string, name: string, item: unknown, initial: unknown): Promise<void> {
    const base: unknown[] = Array.isArray(initial) ? (initial as unknown[]) : [];
    const seeded = [...base, item];
    await this.db.query(
      `INSERT INTO airun_state (scope_key, name, value)
       VALUES ($1, $2, jsonb_build_object('v', $3::jsonb))
       ON CONFLICT (scope_key, name) DO UPDATE
       SET value = jsonb_build_object('v',
         CASE WHEN jsonb_typeof(airun_state.value -> 'v') = 'array'
              THEN airun_state.value -> 'v'
              ELSE '[]'::jsonb
         END || $4::jsonb)`,
      [scopeKey, name, JSON.stringify(seeded), JSON.stringify([item])],
    );
  }

  async mergeState(scopeKey: string, name: string, partial: unknown, initial: unknown): Promise<void> {
    const base: Record<string, unknown> =
      initial && typeof initial === "object" && !Array.isArray(initial)
        ? (initial as Record<string, unknown>)
        : {};
    const seeded = { ...base, ...(partial as Record<string, unknown>) };
    await this.db.query(
      `INSERT INTO airun_state (scope_key, name, value)
       VALUES ($1, $2, jsonb_build_object('v', $3::jsonb))
       ON CONFLICT (scope_key, name) DO UPDATE
       SET value = jsonb_build_object('v',
         CASE WHEN jsonb_typeof(airun_state.value -> 'v') = 'object'
              THEN airun_state.value -> 'v'
              ELSE '{}'::jsonb
         END || $4::jsonb)`,
      [scopeKey, name, JSON.stringify(seeded), JSON.stringify(partial)],
    );
  }
}

/** Build a Postgres-backed journal over a `pg.Pool`-compatible query surface. */
export function postgresJournal(db: Queryable): PostgresJournal {
  return new PostgresJournal(db);
}
