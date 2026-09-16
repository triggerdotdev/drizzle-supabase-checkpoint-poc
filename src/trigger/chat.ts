import { anthropic } from "@ai-sdk/anthropic";
import { metadata } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { sql } from "drizzle-orm";
import { db, getPoolState } from "../db.js";

export const databaseChat = chat.agent({
  id: "database-chat",
  machine: "small-1x",
  maxTurns: 2,
  idleTimeoutInSeconds: 1,
  onTurnStart: async ({ turn }) => {
    // A normal Drizzle query returns its client to the pool before model work.
    const result = await db.execute(
      sql`select current_timestamp as database_time`,
    );
    metadata.set("databaseTurn", {
      turn,
      at: new Date().toISOString(),
      databaseTime: String(result.rows[0]?.database_time),
      pool: getPoolState(),
    });
  },
  run: async ({ messages, signal, streamText }) => {
    return streamText({
      model: anthropic(process.env.POC_MODEL ?? "claude-haiku-4-5-20251001"),
      messages,
      abortSignal: signal,
      maxOutputTokens: 60,
      maxRetries: 0,
    });
  },
});
