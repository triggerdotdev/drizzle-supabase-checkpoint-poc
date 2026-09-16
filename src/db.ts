import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { connectionConfig } from "./connection.js";

// One reusable pool object. Construction does not open a connection.
export const pool = new Pool({
  ...connectionConfig(process.env.DATABASE_URL!, "checkpoint-poc:chat"),
  max: 1, // This example queries sequentially.
  idleTimeoutMillis: 10_000,
});

// A broken IDLE client can emit an error when no query is awaiting a result.
// pg removes that client itself. This listener records the background error and
// prevents an unhandled EventEmitter error from terminating the worker.
// It does not retry a failed query or rescue an open transaction.
pool.on("error", (error) => {
  console.error("Idle database connection closed", { message: error.message });
});

export const db = drizzle({ client: pool });
