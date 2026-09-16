import { randomUUID } from "node:crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { logger, metadata } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { connectionConfig, samplePool } from "../connection.js";

const clientDataSchema = z.object({
  experimentId: z.string().min(1).max(100),
  mode: z.enum(["released", "idle-pool", "held-client", "held-transaction"]),
});
const moduleId = randomUUID();
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type QueryDb = Pick<ReturnType<typeof drizzle>, "execute">;
let pool: Pool | undefined;
let heldClient: PoolClient | undefined;
let queryDb: QueryDb | undefined;
let transactionJob: Promise<void> | undefined;
let finishTransaction: (() => void) | undefined;
let transactionError: string | undefined;
let opened = false;
let suspendCount = 0;
let resumeCount = 0;
const socketEvents: { event: string; at: string; message?: string }[] = [];
function note(event: string, error?: Error) {
  socketEvents.push({
    event,
    at: new Date().toISOString(),
    ...(error ? { message: error.message } : {}),
  });
}
function snapshot() {
  return {
    at: new Date().toISOString(),
    moduleId,
    suspendCount,
    resumeCount,
    pool: pool ? samplePool(pool) : undefined,
    socketEvents: [...socketEvents],
    transactionError,
  };
}

export const checkpointChat = chat.agent({
  id: "database-checkpoint-experiment",
  clientDataSchema,
  machine: "small-1x",
  maxTurns: 2,
  turnTimeout: "10m",
  idleTimeoutInSeconds: 1,
  onChatSuspend: async ({ phase }) => {
    suspendCount++;
    metadata.set("checkpointSuspend", json({ ...snapshot(), phase }));
    logger.info("Checkpoint POC suspend: connection deliberately retained", {
      ...snapshot(),
      phase,
    });
  },
  onChatResume: async ({ phase }) => {
    resumeCount++;
    metadata.set("checkpointResume", json({ ...snapshot(), phase }));
    logger.info("Checkpoint POC resume before SQL", { ...snapshot(), phase });
  },
  run: async ({
    clientData: rawData,
    chatId,
    messages,
    signal,
    streamText,
  }) => {
    const data = clientDataSchema.parse(rawData);
    if (!opened) {
      const result = streamText({
        model: anthropic(process.env.POC_MODEL ?? "claude-haiku-4-5-20251001"),
        messages,
        abortSignal: signal,
        maxOutputTokens: 60,
        maxRetries: 0,
      });
      await chat.pipe(result);
      if (!(await result.text).length)
        throw new Error("The real model stream was empty");
      const label = `checkpoint-poc:${chatId}`;
      pool = new Pool({
        ...connectionConfig(process.env.DATABASE_URL!, label),
        max: 1,
        // Controls separate idle expiry from checkpoint teardown; held clients never use this timer.
        idleTimeoutMillis: data.mode === "released" ? 10_000 : 300_000,
        query_timeout: 15_000,
      });
      pool.on("connect", (client) => {
        note("connect");
        client.on("error", (error) => note("client-error", error));
        client.on("end", () => note("client-end"));
      });
      pool.on("remove", () => note("pool-remove"));
      pool.on("error", (error) => note("pool-error", error));
      const db = drizzle({ client: pool });
      let first: Record<string, unknown> | undefined;
      if (data.mode === "held-transaction") {
        const gate = deferred();
        const ready = deferred();
        finishTransaction = () => gate.resolve();
        transactionJob = db
          .transaction(async (tx) => {
            queryDb = tx;
            await tx.execute(
              sql`select set_config('application_name', ${label}, true)`,
            );
            // Scoped to this disposable transaction; bounds cleanup if the harness is interrupted.
            await tx.execute(
              sql`set local idle_in_transaction_session_timeout = '8min'`,
            );
            const before =
              await tx.execute(sql`select pg_backend_pid() as pid, txid_current()::text as txid,
            current_setting('idle_in_transaction_session_timeout') as idle_transaction_timeout`);
            first = before.rows[0];
            ready.resolve();
            // The Drizzle transaction callback stays unresolved THROUGH the between-turn checkpoint.
            await gate.promise;
          })
          .catch((error: unknown) => {
            transactionError =
              error instanceof Error ? error.message : String(error);
            ready.reject(error);
          });
        await ready.promise;
      } else {
        if (data.mode === "held-client") {
          heldClient = await pool.connect();
          queryDb = drizzle({ client: heldClient });
        } else queryDb = db;
        first = (await queryDb.execute(sql`select pg_backend_pid() as pid`))
          .rows[0];
      }
      opened = true;
      const before = {
        ...snapshot(),
        mode: data.mode,
        experimentId: data.experimentId,
        chatId,
        label,
        first,
        modelCharacters: (await result.text).length,
      };
      metadata.set("checkpointBefore", json(before));
      chat.response.write({ type: "data-checkpoint-before", data: before });
      logger.info("Checkpoint POC connection ready", before);
      // No release, commit, or pool.end here. The chat now suspends between turns.
      return;
    }

    const beforeQuery = snapshot();
    let queryResult: Record<string, unknown> | undefined;
    let queryError: string | undefined;
    try {
      queryResult = (
        await queryDb!.execute(
          data.mode === "held-transaction"
            ? sql`select pg_backend_pid() as pid, txid_current()::text as txid`
            : sql`select pg_backend_pid() as pid`,
        )
      ).rows[0];
    } catch (error) {
      queryError = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.cause instanceof Error)
        queryError += `; cause: ${error.cause.message}`;
    }
    const afterQuery = snapshot();
    // Cleanup is deliberately AFTER the resumed query has tested the retained connection.
    finishTransaction?.();
    if (transactionJob) await transactionJob;
    if (heldClient) {
      heldClient.release(true);
      heldClient = undefined;
    }
    await pool!.end();
    const after = {
      beforeQuery,
      queryResult,
      queryError,
      afterQuery,
      cleanup: snapshot(),
    };
    metadata.set("checkpointAfter", json(after));
    chat.response.write({ type: "data-checkpoint-after", data: after });
    logger.info("Checkpoint POC query after resume and cleanup", after);
  },
});
