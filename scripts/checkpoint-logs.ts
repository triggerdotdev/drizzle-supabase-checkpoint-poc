import "./env.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const reportPath = process.argv[2];
const token = process.env.SUPABASE_ACCESS_TOKEN;
assert(reportPath, "Pass the evidence/run_<id>.json file written by pnpm e2e");
assert(
  token,
  "Set SUPABASE_ACCESS_TOKEN locally to read your project's pooler logs",
);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
assert(
  report.passed && report.checkpoint && report.completedAt,
  "Expected a successful E2E report",
);
const projectRef = new URL(process.env.DATABASE_URL!).username
  .split(".")
  .at(-1);
assert(
  projectRef && projectRef !== "postgres",
  "DATABASE_URL must use the Supavisor transaction endpoint",
);
const url = new URL(
  `https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs.all`,
);
url.searchParams.set(
  "sql",
  "select timestamp, event_message from supavisor_logs order by timestamp asc limit 1000",
);
url.searchParams.set("iso_timestamp_start", report.startedAt);
url.searchParams.set("iso_timestamp_end", report.completedAt);
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
assert(response.ok, `Pooler logs HTTP ${response.status}`);
const body = (await response.json()) as {
  error?: string;
  result?: { timestamp: number | string; event_message: string }[];
};
assert(
  !body.error && Array.isArray(body.result),
  body.error ?? "Unexpected logs response",
);
assert(
  body.result.length < 1000,
  "Log limit reached; narrow the interval before drawing conclusions",
);
const rows = body.result.map((row) => ({
  at:
    typeof row.timestamp === "number"
      ? new Date(row.timestamp / 1000).toISOString()
      : row.timestamp,
  message: row.event_message,
}));
report.poolerLogEvidence = {
  source: "Supabase Management API / supavisor_logs",
  rows,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const closed = rows.find(
  (row) =>
    row.at >= report.checkpoint.at &&
    row.at < report.resumeRequestedAt &&
    row.message.includes("Client socket closed"),
);
console.log(
  JSON.stringify({
    reportPath,
    remoteSocketClosedAt: closed?.at ?? null,
    secondsAfterCheckpoint: closed
      ? (Date.parse(closed.at) - Date.parse(report.checkpoint.at)) / 1000
      : null,
  }),
);
