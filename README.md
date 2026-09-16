# Drizzle + Supabase across a chat checkpoint

One deployed Trigger.dev chat agent queries Supabase, streams a model response, checkpoints
between messages, then queries again through the same Drizzle pool.

## Findings

**The pool object survived checkpointing, but its network connection closed.** In the deployed
test, Supabase logged the client socket closing **1.92 seconds after checkpoint**. After leaving
the chat suspended for 130 seconds, the harness sent another message. The same pool opened a
fresh connection and the next Drizzle query succeeded, without explicit reconnection or SQL
retries. Both database queries and both real model responses completed successfully.

The pool's connection counter increased from **1 to 2**. We deliberately used a five-minute
idle timeout, longer than the **169.953 seconds** between queries, to distinguish checkpoint
behavior from ordinary idle connection expiry. The test requires actual engine checkpoint and
continuation events. See the [measured timeline and evidence](results/README.md).

The chat did not retain its client connection throughout suspension in this test. The
1.92-second timing is an observation, not a guaranteed deadline. This measures the connection
to Supavisor; Supavisor can retain reusable backend connections independently. The POC does
not establish the cause of production connection pressure or quantify potential savings.

## Recommended setup

- **Create the Drizzle client and underlying `pg.Pool` once at module scope.** Reuse them across
  queries, using Supabase's transaction pooler endpoint on port 6543.
- **Keep the pool small.** Start with `max: 1` for sequential queries; increase it if a run needs
  parallel database work. `max: 10` is a ceiling: `pg` creates connections on demand, so it does
  not mean ten connections are always open. See [pool configuration](https://node-postgres.com/apis/pool#new-pool).
- **Keep transactions short and release checked-out clients before model calls or waits.**
  Acquire what you need again for subsequent database work. This example returns its client to
  the pool before model work and holds no transaction across the wait.
- **Use a short production idle timeout**, such as `idleTimeoutMillis: 10_000`. The five-minute
  setting in this repo is specifically for the experiment. Avoid calling `pool.end()` at
  suspension because that permanently closes the pool. See the
  [database connections guide](https://trigger.dev/docs/database-connections).
- **Add `pool.on("error", ...)` to handle background connection errors.** An idle connection can
  break when no query is running. `pg` removes the broken client; the listener prevents its
  error becoming unhandled. Later queries can acquire a fresh connection. The listener does
  not retry SQL or repair an open transaction, and query failures still reject normally.
  See [node-postgres error events](https://node-postgres.com/apis/pool#error).

## The example

- [The chat agent](src/trigger/chat.ts): query in `onTurnStart`, then return `streamText(...)`.
- [The database pool](src/db.ts): one pool, with counters to show when connections open.
- [The E2E test](scripts/e2e.ts): two messages separated by an actual checkpoint.

The agent uses `streamText` from the `run` argument and returns its result. `chat.agent` handles
streaming automatically, as described in the [chat backend docs](https://trigger.dev/docs/ai-chat/backend#simple-return-a-streamtextresult).

## Run it

Use a Trigger.dev project with chat agents and deployed checkpointing, a Supabase project, and
an Anthropic API key. The SQL is read-only and requires no schema setup.

```sh
nvm use
corepack pnpm install --frozen-lockfile
cp .env.example .env
```

Fill in `.env`. Use Supabase's **transaction pooler** connection string on port 6543, from its
Connect dialog. Set `DATABASE_CA_PEM` if your connection needs a provider CA; TLS verification
stays enabled. A quoted PEM value can use `\n` for newlines.

In your Trigger.dev project's deployed environment, set `DATABASE_URL`, `DATABASE_CA_PEM` if
needed, `ANTHROPIC_API_KEY`, and `POC_MODEL`. Keep `TRIGGER_SECRET_KEY` local, pointing at that same
deployed environment.

```sh
corepack pnpm exec trigger login
corepack pnpm run typecheck
corepack pnpm run deploy
corepack pnpm run e2e
```

For a custom Trigger deployment, set `TRIGGER_API_URL` for the harness and pass the matching
`--api-url` and `--profile` options to the CLI. The usual cloud endpoint is the default.

The test takes roughly three minutes and makes two short real model calls. It closes the chat
afterwards. Local `trigger dev` does not demonstrate checkpointing. A suspend hook alone is not
proof: the test requires engine checkpoint and continuation events. If no checkpoint appears
within two minutes, it fails and saves the engine events rather than claiming a successful test.

## Optional: confirm when the remote socket closed

The E2E report is saved under ignored `evidence/`. To add independent Supavisor log timestamps,
set `SUPABASE_ACCESS_TOKEN` locally and run:

```sh
corepack pnpm run logs evidence/run_<id>.json
```

This uses Supabase's Management API. Use a dedicated test project: project-wide logs correlated
by time cannot identify one connection among arbitrary production traffic. Log ingestion can
lag. Missing closure evidence is reported as missing, never as zero connections. A Node error
delivered after restore is not the timestamp when the remote socket closed.

The management token stays local and is not needed for the main test. Review raw evidence before
sharing it. This is a lifecycle POC, not a database load test or a production cost estimate.
