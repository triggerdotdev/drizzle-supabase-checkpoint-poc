# Drizzle + Supabase connections across a Trigger.dev chat checkpoint

A runnable chat example and an experiment that checks what happens to database connections
when a deployed chat agent checkpoints between messages, then resumes in the same process state.

Start with [the recommended chat](src/trigger/chat.ts) and [its database pool](src/db.ts).
The separate [checkpoint experiment](src/trigger/checkpoint-chat.ts) deliberately retains clients
and transactions to measure their behavior. Those retained-handle cases are diagnostic controls.

## What this demonstrates

The initial deployed experiment found that the pool object survived checkpointing, while its
original connections closed. Pool-based queries recovered after resume. Retained checked-out
clients and open transactions were no longer usable. See [recorded results](results/README.md).

The recommended example finishes SQL before streaming the model response. Each turn queries
through the same module-level Drizzle pool; neither a client nor a transaction spans the wait.

```ts
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 10_000,
});
pool.on("error", (error) => {
  console.error("Idle connection error", error.message);
});
const db = drizzle({ client: pool });
```

This abbreviated snippet omits TLS configuration. The runnable [connection helper](src/connection.ts)
verifies TLS and accepts an optional provider CA. `max` is a ceiling: pools open connections lazily.
Use a larger ceiling only when your run actually needs concurrent database queries.

## What does `pool.on("error")` do?

Consider a connection that has been returned to the pool:

1. The worker checkpoints, and its database socket closes.
2. After restore, Node notices the closed socket. There may be no query running to reject.
3. `pg` removes the broken idle client and emits a background `error` event on the pool.
4. The listener records that error. Without a listener, an unhandled EventEmitter error can
   terminate the worker. A subsequent query can acquire a fresh connection from the pool.

The listener does **not** reconnect a checked-out client, retry an interrupted query, or make a
failed transaction succeed. Query failures still propagate to the code awaiting them. Do not
silently retry writes without considering transaction outcome and idempotency.

Do not call `pool.end()` in a suspend hook: it permanently shuts down this `pg` pool. A short idle
timeout removes returned clients while keeping the pool usable. Ten seconds is already `pg`'s
default; it cannot expire a client that your code still has checked out.

See the [node-postgres error-event documentation](https://node-postgres.com/apis/pool#error)
and [Trigger.dev database connections guide](https://trigger.dev/docs/database-connections).

## Run against your own projects

You need a Trigger.dev project with chat agents and deployed checkpointing, a disposable Supabase
project, and an Anthropic key. Local `trigger dev` does not prove checkpoint behavior. The main
experiment uses only diagnostic SQL; no migrations or application tables are required.

1. Use Node from `.nvmrc`, then install the pinned dependencies:

   ```sh
   nvm use
   corepack pnpm install --frozen-lockfile
   cp .env.example .env
   ```

2. Fill in `.env` with your Trigger project ref and deployed environment key, Supavisor
   **transaction-mode** URL on port 6543, and a **session-mode** URL on 5432 (or direct connection)
   to the same database for external observation. Use the same database role for both URLs.
   Get connection strings from Supabase's Connect dialog. Set `DATABASE_CA_PEM` if a provider CA
   is needed; use a quoted value with `\n` escapes for a multiline PEM.

3. In your Trigger.dev project's environment settings, upload **only** `DATABASE_URL`,
   `DATABASE_CA_PEM` if needed, `ANTHROPIC_API_KEY`, and `POC_MODEL`. The observer URL and optional
   Supabase management/metrics credentials stay local.

4. Authenticate and deploy to the same environment as `TRIGGER_SECRET_KEY`:

   ```sh
   corepack pnpm exec trigger login
   corepack pnpm run typecheck
   corepack pnpm run deploy
   ```

   For a custom Trigger deployment, set `TRIGGER_API_URL` in `.env` for the harness, and pass
   the CLI's matching `--api-url` and `--profile` options when logging in or deploying.

5. Run the small recommended example, or the four-case experiment:

   ```sh
   corepack pnpm run e2e:chat
   corepack pnpm run e2e
   # Or select one experiment case:
   corepack pnpm run e2e idle-pool
   ```

The recommended example sends two real model messages and verifies SQL succeeds before and after
an engine-confirmed checkpoint. The four-case experiment takes about 13 minutes: each case waits
130 seconds after checkpoint confirmation before resuming. It makes one short real model call per
case, capped at 60 output tokens. Runs are closed by the harness; there are no recurring jobs.

## Experiment cases

| Case               | What remains after turn one             | What turn two measures                                 |
| ------------------ | --------------------------------------- | ------------------------------------------------------ |
| `released`         | Returned client; 10-second idle timeout | Pool reconnects after idle expiry                      |
| `idle-pool`        | Returned client; 5-minute idle timeout  | Checkpoint closes it before idle expiry; pool recovers |
| `held-client`      | Checked-out client; no transaction      | Whether the exact retained client remains queryable    |
| `held-transaction` | Unresolved Drizzle transaction callback | Whether the exact open transaction remains queryable   |

The first turn opens the experiment connection **after** its short model stream, so the test
isolates the between-turn checkpoint. No suspend/resume hook closes a client. Cleanup happens
only after the resumed query. The held transaction has a transaction-local 8-minute idle timeout
as a cleanup bound; no global database settings, application rows or application locks are changed.

## Evidence and interpretation

The experiment requires the engine's checkpoint-creation and continuation events. A lifecycle
hook, a WAITING status, or reuse of a run ID alone does not pass. The harness also verifies module
state survives and samples `pg_stat_activity` externally approximately every 500 ms throughout
suspension. Pool-based queries must recover; held-handle query errors are recorded explicitly.

Raw reports and run traces are written to ignored `evidence/`. These are local diagnostic files
and should be reviewed before sharing. To attach independent socket-closure timestamps, set a
local `SUPABASE_ACCESS_TOKEN` and run:

```sh
corepack pnpm run logs evidence/checkpoint-<timestamp>.json
corepack pnpm run report evidence/checkpoint-<timestamp>.json
```

The log reader uses Supabase's public Management API `supavisor_logs` source table. Log ingestion
may lag; retry collection if recent events are missing. It stops on API errors or a full result
limit instead of interpreting missing logs as zero connections. The summary omits project/run
identifiers and raw database observations. Time-based correlation assumes a dedicated database
project and serial tests; it cannot attribute arbitrary production traffic to one run.

Optional metrics use `SUPABASE_METRICS_URL` and `SUPABASE_METRICS_KEY` from `.env` and are scraped
every 60 seconds. Missing series remain missing. Pooler metrics can lag; they do not establish
the exact disconnect time. Node's error event after restore is also **not** the remote close time.

Supavisor can retain unused backend connections after the client disconnects. A cached idle backend
does not mean the chat still owns a transaction or reserves that backend. Client slots and backend
capacity are separate limits; see [Supabase pooling and limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits).

This is a connection-lifecycle experiment, not a load test or a production cost estimate. Checkpoint
timing depends on the deployment. The harness fails if it cannot establish an actual checkpoint.
