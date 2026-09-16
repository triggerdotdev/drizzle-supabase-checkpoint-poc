import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { connectionConfig } from "./connection.js";

// Longer than the E2E wait so idle expiry cannot explain reconnection.
// Use a short timeout such as 10_000 when adapting this for production.
export const idleTimeoutMillis = 300_000;
const pool = new Pool({
  ...connectionConfig(process.env.DATABASE_URL!, "checkpoint-poc:chat"),
  max: 1,
  idleTimeoutMillis,
});

// These counters make the checkpoint behavior visible in run metadata.
const poolId = randomUUID();
let connectionsOpened = 0;
let idleErrors = 0;
pool.on("connect", () => connectionsOpened++);
pool.on("error", (error) => {
  // pg already removes the broken idle client. This handles the background error;
  // it does not retry a query or revive a transaction.
  idleErrors++;
  console.error("Idle database connection closed", { message: error.message });
});

export const db = drizzle({ client: pool });
export function getPoolState() {
  return {
    poolId,
    connectionsOpened,
    idleErrors,
    total: pool.totalCount,
    idle: pool.idleCount,
    idleTimeoutMillis,
  };
}
export type PoolState = ReturnType<typeof getPoolState>;
