# Measured checkpoint behavior

## Standalone example verification

The recommended example in this repository was deployed and verified on 16 September 2026.
`pnpm run e2e:chat` confirmed two successful database queries, two real model responses, an
engine checkpoint-creation event, continuation after that checkpoint, and the same module UUID
on both turns. Both SQL operations returned their clients to the pool before model streaming.

## Reference experiment

The initial four-case experiment ran on 16 September 2026 using Trigger.dev SDK/CLI 4.6.1,
Drizzle 0.45.2, node-postgres 8.23.0, and Supabase's shared transaction pooler. It used an actual
deployed chat agent and real Anthropic responses. Each case remained suspended for more than
two minutes after the engine recorded checkpoint creation.

| Case | Remote socket closure relative to checkpoint | SQL through retained state after resume |
| --- | --- | --- |
| Open transaction | 2.00 seconds after | Failed: retained client was no longer queryable |
| Checked-out client | 2.03 seconds after | Failed: retained client was no longer queryable |
| Returned client, 5-minute timeout | 1.75 seconds after | Succeeded: pool opened a new connection |
| Returned client, 10-second timeout | 14.85 seconds before | Succeeded: pool opened a new connection |

[Sanitized timestamps and measurements](reference-2026-09-16.json) are included. This reference
run preceded standalone packaging; the connection-lifecycle cases were extracted into this repo.

Supavisor logs supplied the remote socket-closure timestamps. In the open-transaction case,
external SQL sampling also observed the original backend disappear approximately two seconds
after checkpoint creation. A later pooler log reported no subscribers to that transaction pool.

The five-minute idle case is the useful illustration of `pool.on("error")`: the remote socket
closed during suspension, the pool removed the dead idle client when the worker resumed, the
error listener recorded it, and the subsequent query opened a new connection. The listener
did not revive the original connection. Both cases retaining a checked-out client failed their
resumed query; their test runs completed only because the experiment records that failure and
then cleans up.

The ten-second case expired before checkpoint creation. An idle chat can still hold a socket
during the transition to a checkpoint; the measured two-second delay is not a guaranteed bound.

These are lifecycle measurements from a test deployment, not production telemetry, saturation
measurements, or estimated cost savings. Supavisor metrics lagged and were not used to time closure.
