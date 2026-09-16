# Drizzle + Supabase across a chat checkpoint

One deployed Trigger.dev chat agent queries Supabase, streams a model response, checkpoints
between messages, then queries again through the same Drizzle pool.

- [The chat agent](src/trigger/chat.ts): query in `onTurnStart`, then return `streamText(...)`.
- [The database pool](src/db.ts): one pool, with counters to show when connections open.
- [The E2E test](scripts/e2e.ts): two messages separated by an actual checkpoint.
- [Measured results](results/README.md).

The agent uses `streamText` from the `run` argument and returns its result. `chat.agent` handles
streaming automatically, as described in the [chat backend docs](https://trigger.dev/docs/ai-chat/backend#simple-return-a-streamtextresult).

## What the test proves

1. The first query succeeds and returns its client to the pool.
2. The engine confirms a real checkpoint. The harness leaves the chat suspended for 130 seconds.
3. The next message resumes the same pool object and makes another successful query.
4. The pool has opened a fresh connection, before its ordinary idle timeout could have expired.

**The five-minute pool idle timeout is deliberate for this POC.** It isolates checkpoint behavior
from ordinary idle expiry. When adapting the example for production, use a short timeout such as
10 seconds, as recommended in the [database connections guide](https://trigger.dev/docs/database-connections).
No client or transaction is held by the application across model work or between turns.

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

## Why the pool has an error listener

An idle connection can break while no query is running. When `pg` detects that, it removes the
client and emits an `error` event on the pool. The listener records this background error so it
doesn't become an unhandled Node error. Later queries can acquire a fresh connection.

The listener does not reconnect a held client or retry failed SQL. Query failures still reject
normally. Don't call `pool.end()` in a suspend hook—it permanently closes that pool.
See [node-postgres error events](https://node-postgres.com/apis/pool#error).

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
