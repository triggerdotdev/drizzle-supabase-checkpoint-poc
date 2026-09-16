import "./env.js";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { configure } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";

const baseURL = process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
const secretKey = process.env.TRIGGER_SECRET_KEY;
assert(
  secretKey && !secretKey.startsWith("tr_dev_"),
  "Use a deployed environment key",
);
configure({ baseURL, secretKey });

export async function poll<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(2000);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function sendMessage(agent: AgentChat, message: string) {
  let text = "";
  const stream = await agent.sendMessage(message, {
    abortSignal: AbortSignal.timeout(120_000),
  });
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") text += chunk.delta;
  }
  assert(text.length > 0, "Expected a real model response");
}

export type EngineEvent = { at: string; message: string };
export async function readEngineEvents(runId: string): Promise<EngineEvent[]> {
  const response = await fetch(`${baseURL}/api/v1/runs/${runId}/trace`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `Trace HTTP ${response.status}`);
  const events: EngineEvent[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (
      typeof row.message === "string" &&
      row.message.startsWith("[engine]") &&
      typeof row.startTime === "string"
    ) {
      events.push({ at: row.startTime, message: row.message });
    }
    for (const child of Object.values(row)) visit(child);
  }
  visit(await response.json());
  return events;
}

export function waitForEngineEvent(runId: string, message: string) {
  return poll(
    async () =>
      (await readEngineEvents(runId)).find((event) =>
        event.message.includes(message),
      ),
    message,
  );
}
