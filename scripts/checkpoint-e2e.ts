import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import "./env.js";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { configure, runs } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";
import { connectionConfig } from "../src/connection.js";

for (const name of ["TRIGGER_SECRET_KEY", "DATABASE_OBSERVER_URL"]) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
const apiUrl = process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
if (process.env.TRIGGER_SECRET_KEY!.startsWith("tr_dev_"))
  throw new Error(
    "Use a deployed environment: local dev cannot prove checkpoints",
  );
configure({ baseURL: apiUrl, secretKey: process.env.TRIGGER_SECRET_KEY });
const metricsAuth =
  process.env.SUPABASE_METRICS_URL && process.env.SUPABASE_METRICS_KEY
    ? {
        url: process.env.SUPABASE_METRICS_URL,
        username: "service_role",
        key: process.env.SUPABASE_METRICS_KEY,
      }
    : undefined;
const allowedModes = [
  "held-transaction",
  "held-client",
  "idle-pool",
  "released",
] as const;
type Mode = (typeof allowedModes)[number];
const modes =
  process.argv.length > 2
    ? (process.argv.slice(2) as Mode[])
    : [...allowedModes];
if (modes.some((mode) => !allowedModes.includes(mode)))
  throw new Error("Unknown checkpoint mode");
const experimentId = `checkpoint-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
mkdirSync("evidence", { recursive: true });
const file = `evidence/${experimentId}.json`;
const observer = new Pool({
  ...connectionConfig(
    process.env.DATABASE_OBSERVER_URL!,
    "checkpoint-poc:observer",
  ),
  max: 1,
  idleTimeoutMillis: 0,
});
const observations: {
  at: string;
  databaseAt: string;
  rows: Record<string, any>[];
}[] = [];
const metrics: {
  at: string;
  status: number;
  date: string | null;
  age: string | null;
  lines: string[];
}[] = [];
const outcomes: Record<string, any>[] = [];
const failures: string[] = [];
const runIds = new Set<string>();
let observing = true;
let activeMode: Mode | undefined;
function save() {
  writeFileSync(
    file,
    JSON.stringify(
      {
        experimentId,
        updatedAt: new Date().toISOString(),
        activeMode,
        failures,
        outcomes,
        observations,
        metrics,
        runIds: [...runIds],
      },
      null,
      2,
    ),
  );
}
observer.on("error", (error) => {
  failures.push(`Observer: ${error.message}`);
  save();
});
const observationTask = (async () => {
  while (observing) {
    try {
      const { rows } =
        await observer.query(`select clock_timestamp() as observed_at, pid, backend_start,
        application_name, state, xact_start, state_change,
        extract(epoch from (clock_timestamp()-xact_start))::float as transaction_age_seconds,
        wait_event_type, wait_event from pg_stat_activity
        where datname=current_database() and usename=current_user and pid<>pg_backend_pid()`);
      observations.push({
        at: new Date().toISOString(),
        databaseAt:
          rows[0]?.observed_at?.toISOString() ?? new Date().toISOString(),
        rows,
      });
    } catch (error) {
      failures.push(`Observer: ${String(error)}`);
      break;
    }
    await delay(500);
  }
})();
async function scrapeMetrics() {
  if (!metricsAuth) return;
  const response = await fetch(metricsAuth.url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${metricsAuth.username}:${metricsAuth.key}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Metrics HTTP ${response.status}`);
  const lines = text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("#") &&
        /^(supavisor_.*(connection|client)|connection_stats_connection_count|direct_connection_stats_connection_count)/.test(
          line,
        ),
    );
  metrics.push({
    at: new Date().toISOString(),
    status: response.status,
    date: response.headers.get("date"),
    age: response.headers.get("age"),
    lines,
  });
  save();
  console.log(
    JSON.stringify({
      event: "metrics",
      activeMode,
      supavisor: lines.filter((line) =>
        line.startsWith("supavisor_connections_active"),
      ),
    }),
  );
}
const metricsTask = (async () => {
  if (!metricsAuth) return;
  while (observing) {
    try {
      await scrapeMetrics();
    } catch (error) {
      failures.push(String(error));
      save();
    }
    // Supabase recommends a 60-second scrape interval. SQL observation is independent and faster.
    for (let i = 0; i < 60 && observing; i++) await delay(1000);
  }
})();
async function poll<T>(
  fn: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 120_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value !== undefined) return value;
    await delay(1000);
  }
  throw new Error(`Timed out: ${label}`);
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function trace(runId: string) {
  const response = await fetch(`${apiUrl}/api/v1/runs/${runId}/trace`, {
    headers: { Authorization: `Bearer ${process.env.TRIGGER_SECRET_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Trace HTTP ${response.status}`);
  const data: unknown = await response.json();
  writeFileSync(
    `evidence/${runId}-checkpoint-trace.json`,
    JSON.stringify(data, null, 2),
  );
  const events: { at: string; message: string }[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const r = value as Record<string, unknown>;
    if (typeof r.message === "string" && r.message.startsWith("[engine]"))
      events.push({ at: String(r.startTime), message: r.message });
    for (const child of Object.values(r))
      if (typeof child === "object") visit(child);
  }
  visit(data);
  return events;
}
async function consume(agent: AgentChat, message: string) {
  const stream = await agent.sendMessage(message, {
    abortSignal: AbortSignal.timeout(120_000),
  });
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

try {
  await delay(2500);
  for (const mode of modes) {
    activeMode = mode;
    const outcome: Record<string, any> = {
      mode,
      startedAt: new Date().toISOString(),
    };
    outcomes.push(outcome);
    const agent = new AgentChat({
      id: randomUUID(),
      agent: "database-checkpoint-experiment",
      clientData: { experimentId, mode },
      triggerConfig: {
        basePayload: {},
        tags: [experimentId, mode],
        maxAttempts: 1,
      },
      onTriggered: ({ runId }) => {
        outcome.runId = runId;
        runIds.add(runId);
        save();
        console.log(JSON.stringify({ event: "started", mode, runId }));
      },
    });
    try {
      outcome.firstStream = await consume(
        agent,
        "Reply with one short sentence confirming this database checkpoint experiment.",
      );
      check(
        outcome.firstStream.some((c: any) => c.type === "text-delta"),
        "No real model response",
      );
      outcome.before = await poll(
        async () =>
          (await runs.retrieve(outcome.runId)).metadata?.checkpointBefore,
        "connection retained before checkpoint",
      );
      save();
      const checkpointDeadline = Date.now() + 120_000;
      while (Date.now() < checkpointDeadline) {
        const events = await trace(outcome.runId);
        const checkpoint = events.find((event) =>
          event.message.includes("suspended after creating a checkpoint"),
        );
        if (checkpoint) {
          outcome.checkpoint = checkpoint;
          break;
        }
        const run = await runs.retrieve(outcome.runId);
        check(!run.isCompleted, `Run ended before checkpoint (${run.status})`);
        await delay(5000);
      }
      check(
        outcome.checkpoint,
        "No engine-confirmed checkpoint; lifecycle hooks alone do not pass",
      );
      outcome.confirmedAt = new Date().toISOString();
      save();
      console.log(
        JSON.stringify({
          event: "checkpoint-confirmed",
          mode,
          runId: outcome.runId,
          at: outcome.checkpoint.at,
          pool: outcome.before.pool,
        }),
      );
      // Observe a full two-minute interval AFTER the engine confirms that the VM was checkpointed.
      // This crosses two recommended metrics scrape intervals, independently of worker timers.
      const holdUntil = Date.now() + 130_000;
      while (Date.now() < holdUntil) {
        const run = await runs.retrieve(outcome.runId);
        check(!run.isCompleted, `Run ended during observation (${run.status})`);
        await delay(5000);
        save();
      }
      outcome.resumeSentAt = new Date().toISOString();
      outcome.secondStream = await consume(
        agent,
        "Resume and query the exact connection retained by the first turn, then clean up.",
      );
      outcome.after = await poll(
        async () =>
          (await runs.retrieve(outcome.runId)).metadata?.checkpointAfter,
        "query and cleanup after restore",
      );
      check(
        outcome.before.moduleId === outcome.after.beforeQuery.moduleId,
        "Module memory changed",
      );
      check(
        outcome.after.beforeQuery.resumeCount > outcome.before.resumeCount,
        "Missing resume hook",
      );
      await agent.close();
      const terminal = await poll(async () => {
        const run = await runs.retrieve(outcome.runId);
        return run.isCompleted ? run : undefined;
      }, "terminal run");
      outcome.terminal = {
        status: terminal.status,
        durationMs: terminal.durationMs,
        costInCents: terminal.costInCents,
        error: terminal.error,
      };
      check(terminal.isSuccess, `Run ended as ${terminal.status}`);
      outcome.engineEvents = await trace(outcome.runId);
      check(
        outcome.engineEvents.some((event: any) =>
          event.message.includes("continued after being suspended"),
        ),
        "No engine-confirmed continuation after checkpoint",
      );
      const start = Date.parse(outcome.checkpoint.at),
        end = Date.parse(outcome.resumeSentAt);
      const interval = observations.filter(
        (sample) =>
          Date.parse(sample.at) >= start && Date.parse(sample.at) < end,
      );
      const retainedTransactions = interval.filter((sample) =>
        sample.rows.some(
          (row) =>
            row.application_name === outcome.before.label &&
            row.state === "idle in transaction",
        ),
      );
      outcome.suspendedObservation = {
        samples: interval.length,
        samplesWithOpenTransaction: retainedTransactions.length,
        maxTransactionAgeSeconds: Math.max(
          0,
          ...retainedTransactions.flatMap((sample) =>
            sample.rows
              .filter((r) => r.application_name === outcome.before.label)
              .map((r) => r.transaction_age_seconds ?? 0),
          ),
        ),
        metrics: metrics.filter(
          (sample) =>
            Date.parse(sample.at) >= start && Date.parse(sample.at) < end,
        ),
      };
      check(
        interval.length >= 100,
        "Insufficient external samples while checkpointed",
      );
      // The held modes deliberately measure stale-handle behavior. The pooled modes must recover.
      if (mode === "released" || mode === "idle-pool") {
        check(
          !outcome.after.queryError && outcome.after.queryResult,
          "Pooled query failed after resume",
        );
      }
      check(
        outcome.after.cleanup.pool.total === 0,
        "Experiment cleanup left clients in the pool",
      );
      outcome.passed = true;
      outcome.finishedAt = new Date().toISOString();
      save();
      console.log(
        JSON.stringify({
          event: "checkpoint-scenario-measured",
          mode,
          runId: outcome.runId,
          observedSuspendedSamples: interval.length,
          transactionRetainedSamples: retainedTransactions.length,
          queryResult: outcome.after.queryResult,
          queryError: outcome.after.queryError,
          socketEvents: outcome.after.cleanup.socketEvents,
        }),
      );
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      failures.push(`${mode}: ${outcome.error}`);
      // A second turn is also the cleanup path if a checkpoint was unavailable.
      if (outcome.before && !outcome.after) {
        try {
          outcome.cleanupStream = await consume(
            agent,
            "Clean up the experiment now.",
          );
        } catch (cleanupError) {
          outcome.cleanupError = String(cleanupError);
        }
      }
      await agent.close().catch(() => {});
      if (outcome.runId) {
        try {
          const terminal = await poll(
            async () => {
              const r = await runs.retrieve(outcome.runId);
              return r.isCompleted ? r : undefined;
            },
            "failed-scenario cleanup",
            30_000,
          );
          outcome.terminal = { status: terminal.status, error: terminal.error };
          outcome.engineEvents = await trace(outcome.runId);
        } catch (cleanupError) {
          outcome.cleanupError = String(cleanupError);
        }
      }
      save();
      console.log(
        JSON.stringify({
          event: "checkpoint-scenario-error",
          mode,
          error: outcome.error,
        }),
      );
    }
    // Observe released client counts before the next mode starts.
    await delay(10_000);
  }
} finally {
  observing = false;
  await Promise.all([observationTask, metricsTask]);
  await observer.end();
  activeMode = undefined;
  save();
}
console.log(
  JSON.stringify({
    experimentId,
    file,
    passed: failures.length === 0,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
