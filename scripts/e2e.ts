import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runs } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";
import type { PoolState } from "../src/db.js";
import {
  poll,
  readEngineEvents,
  sendMessage,
  waitForEngineEvent,
} from "./trigger-client.js";

type DatabaseTurn = {
  turn: number;
  at: string;
  databaseTime: string;
  pool: PoolState;
};
const startedAt = new Date().toISOString();
let runId = "";
const agent = new AgentChat({
  id: randomUUID(),
  agent: "database-chat",
  triggerConfig: { basePayload: {}, maxAttempts: 1 },
  onTriggered: (run) => {
    runId = run.runId;
    console.log(JSON.stringify({ runId }));
  },
});
async function readTurn(after?: number) {
  return poll(async () => {
    const value = (await runs.retrieve(runId)).metadata?.databaseTurn as
      | DatabaseTurn
      | undefined;
    return value && (after === undefined || value.turn > after)
      ? value
      : undefined;
  }, "database query metadata");
}

try {
  await sendMessage(agent, "Say hello in one short sentence.");
  const first = await readTurn();
  assert.equal(first.pool.total, 1);
  assert.equal(
    first.pool.idle,
    1,
    "The query should return its client to the pool",
  );

  const checkpoint = await waitForEngineEvent(
    runId,
    "suspended after creating a checkpoint",
  );
  console.log(
    "Checkpoint confirmed. Leaving the chat suspended for 130 seconds.",
  );
  await delay(130_000);

  const resumeRequestedAt = new Date().toISOString();
  await sendMessage(agent, "Say hello again in one short sentence.");
  const second = await readTurn(first.turn);
  const continuation = await waitForEngineEvent(
    runId,
    "continued after being suspended",
  );
  assert.equal(
    second.pool.poolId,
    first.pool.poolId,
    "The same pool object should survive",
  );
  assert(
    second.pool.connectionsOpened > first.pool.connectionsOpened,
    "A fresh connection should open after resume",
  );
  assert.equal(second.pool.total, 1);
  assert.equal(second.pool.idle, 1);
  assert(
    Date.parse(second.at) - Date.parse(first.at) < first.pool.idleTimeoutMillis,
    "The test took too long to rule out ordinary idle expiry",
  );

  await agent.close();
  const terminal = await poll(async () => {
    const run = await runs.retrieve(runId);
    return run.isCompleted ? run : undefined;
  }, "run completion");
  assert(terminal.isSuccess, `Run ended as ${terminal.status}`);
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    runId,
    first,
    checkpoint,
    resumeRequestedAt,
    second,
    continuation,
    status: terminal.status,
    passed: true,
  };
  mkdirSync("evidence", { recursive: true });
  const file = `evidence/${runId}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      file,
      passed: true,
      before: first.pool,
      after: second.pool,
    }),
  );
} catch (error) {
  mkdirSync("evidence", { recursive: true });
  const events = runId ? await readEngineEvents(runId).catch(() => []) : [];
  writeFileSync(
    `evidence/${runId || "unstarted"}-failed.json`,
    JSON.stringify(
      {
        startedAt,
        runId,
        error: error instanceof Error ? error.message : String(error),
        events,
        passed: false,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await agent.close().catch(() => {});
}
