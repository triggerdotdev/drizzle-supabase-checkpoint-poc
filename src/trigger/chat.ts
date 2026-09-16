import { randomUUID } from "node:crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { metadata } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { samplePool } from "../connection.js";

const moduleId = randomUUID();
let turn = 0;

export const databaseChat = chat.agent({
  id: "database-chat",
  machine: "small-1x",
  maxTurns: 2,
  idleTimeoutInSeconds: 1,
  run: async ({ messages, signal, streamText }) => {
    // Put real reads/writes here. This read-only query needs no schema setup.
    // Awaiting it returns the client to the pool before model work begins.
    const result = await db.execute(
      sql`select current_timestamp as database_time`,
    );
    metadata.set("databaseTurn", {
      turn: ++turn,
      moduleId,
      databaseTime: String(result.rows[0]?.database_time),
      poolAfterQuery: samplePool(pool),
    });

    await chat.pipe(
      streamText({
        model: anthropic(process.env.POC_MODEL ?? "claude-haiku-4-5-20251001"),
        system:
          "You are a concise assistant in a database checkpoint demonstration.",
        messages,
        abortSignal: signal,
        maxOutputTokens: 60,
        maxRetries: 0,
      }),
    );
    // Keep the pool usable across turns. No transaction or checked-out client is
    // retained, and no pool.end() is needed in a suspend hook.
  },
});
