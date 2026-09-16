import "./env.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { configure, runs } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";

const baseURL = process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
const secretKey = process.env.TRIGGER_SECRET_KEY;
if (!secretKey || secretKey.startsWith("tr_dev_"))
  throw new Error("Use a deployed environment key");
configure({ baseURL, secretKey });
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
async function send(message: string) {
  let text = "";
  for await (const chunk of await agent.sendMessage(message, {
    abortSignal: AbortSignal.timeout(120_000),
  })) {
    if (chunk.type === "text-delta") text += chunk.delta;
  }
  if (!text) throw new Error("No model response");
  return text;
}
async function poll<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(2000);
  }
  throw new Error(`Timed out: ${label}`);
}
async function engineEvent(message: string) {
  const response = await fetch(`${baseURL}/api/v1/runs/${runId}/trace`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Trace HTTP ${response.status}`);
  const value: unknown = await response.json();
  function find(item: unknown): Record<string, unknown> | undefined {
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    if (
      typeof row.message === "string" &&
      row.message.startsWith("[engine]") &&
      row.message.includes(message)
    )
      return row;
    for (const child of Object.values(row)) {
      const match = find(child);
      if (match) return match;
    }
  }
  return find(value);
}
try {
  const firstText = await send("Say hello in one short sentence.");
  const first = await poll(
    async () =>
      (await runs.retrieve(runId)).metadata?.databaseTurn as
        | {
            turn: number;
            moduleId: string;
            poolAfterQuery: { checkedOut: number };
          }
        | undefined,
    "first query",
  );
  const checkpoint = await poll(
    () => engineEvent("suspended after creating a checkpoint"),
    "actual checkpoint",
  );
  console.log("Checkpoint confirmed; sending the next message in 20 seconds.");
  await delay(20_000);
  const secondText = await send("Say hello again in one short sentence.");
  const second = await poll(async () => {
    const value = (await runs.retrieve(runId)).metadata?.databaseTurn as
      | typeof first
      | undefined;
    return value?.turn === 2 ? value : undefined;
  }, "second query");
  if (
    first.moduleId !== second.moduleId ||
    first.poolAfterQuery.checkedOut !== 0 ||
    second.poolAfterQuery.checkedOut !== 0
  ) {
    throw new Error("Module state or client-release assertion failed");
  }
  await agent.close();
  const terminal = await poll(async () => {
    const run = await runs.retrieve(runId);
    return run.isCompleted ? run : undefined;
  }, "completion");
  if (!terminal.isSuccess) throw new Error(`Run ended as ${terminal.status}`);
  const continuation = await poll(
    () => engineEvent("continued after being suspended"),
    "continuation",
  );
  mkdirSync("evidence", { recursive: true });
  writeFileSync(
    `evidence/${runId}-chat.json`,
    JSON.stringify(
      {
        runId,
        first,
        second,
        firstText,
        secondText,
        checkpoint,
        continuation,
        status: terminal.status,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      runId,
      queries: 2,
      modelResponses: 2,
      actualCheckpoint: true,
      sameModule: true,
    }),
  );
} finally {
  await agent.close().catch(() => {});
}
