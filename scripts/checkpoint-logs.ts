import "./env.js";
import { readFileSync, writeFileSync } from "node:fs";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Pass evidence/checkpoint-<timestamp>.json");
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token)
  throw new Error(
    "Set SUPABASE_ACCESS_TOKEN locally to read your project's pooler logs",
  );
const projectRef = new URL(process.env.DATABASE_URL!).username
  .split(".")
  .at(-1);
if (!projectRef || projectRef === "postgres")
  throw new Error("DATABASE_URL must use the Supavisor transaction endpoint");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const url = new URL(
  `https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs.all`,
);
url.searchParams.set(
  "sql",
  "select timestamp, event_message from supavisor_logs order by timestamp asc limit 1000",
);
url.searchParams.set("iso_timestamp_start", report.outcomes[0].startedAt);
url.searchParams.set("iso_timestamp_end", report.updatedAt);
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`Pooler logs HTTP ${response.status}`);
const body = (await response.json()) as {
  error?: string;
  result?: { timestamp: number | string; event_message: string }[];
};
if (body.error || !Array.isArray(body.result))
  throw new Error(body.error ?? "Unexpected logs response");
if (body.result.length === 1000)
  throw new Error(
    "Log limit reached; narrow the interval before drawing conclusions",
  );
report.poolerLogEvidence = {
  fetchedAt: new Date().toISOString(),
  source: "Supabase Management API / supavisor_logs",
  rows: body.result.map((row) => ({
    at:
      typeof row.timestamp === "number"
        ? new Date(row.timestamp / 1000).toISOString()
        : row.timestamp,
    message: row.event_message,
  })),
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, poolerLogRows: body.result.length }));
