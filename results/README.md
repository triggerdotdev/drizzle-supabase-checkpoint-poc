# Deployed verification

The focused E2E passed on 16 September 2026 using Trigger.dev test cloud, Supabase's
transaction pooler on port 6543, Drizzle 0.45.2, `pg` 8.23.0, and Trigger.dev SDK 4.6.1.
Both turns streamed real Anthropic responses, both database queries succeeded, and the
run completed successfully. See the [sanitized measurement record](checkpoint-2026-09-16.json).

| Event | UTC |
| --- | --- |
| First query completed; one idle client in the pool | 15:22:05.329 |
| Engine confirmed checkpoint | 15:22:31.143 |
| Supavisor logged the client socket closing | 15:22:33.063 |
| Harness sent the second message | 15:24:43.227 |
| Engine confirmed continuation | 15:24:49.718 |
| Second query completed through a fresh connection | 15:24:55.282 |

The pool object's identity survived. Its connection counter increased from **1 to 2**,
and its background error counter increased from **0 to 1**. After each query, the pool
had one client, returned and idle.

Only **169.953 seconds** elapsed between the queries, less than the deliberately configured
300-second idle timeout. Ordinary idle expiry therefore cannot explain the fresh connection.
Supavisor independently reported the old client socket closing **1.920 seconds after the
checkpoint**, well before the second message. The pool object survived in memory; its old
network connection did not stay open throughout suspension.

The error listener handles `pg`'s background error after restore; `pg` removes the broken idle
client and opens another when queried. No explicit reconnect or SQL retry was needed here.

These are observations from one isolated test, not a guaranteed teardown deadline. Pooler
logs were correlated by time in a dedicated project. They describe the client socket to
Supavisor, not the size of Supavisor's reusable backend pool. The example does not hold a
client or transaction across the wait, and does not establish production capacity or billing.
