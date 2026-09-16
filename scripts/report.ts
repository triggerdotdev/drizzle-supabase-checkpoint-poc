import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Pass evidence/checkpoint-<timestamp>.json");
const report = JSON.parse(readFileSync(path, "utf8"));
const logs = report.poolerLogEvidence?.rows ?? [];
const results = report.outcomes.map((outcome: any) => {
  const checkpoint = outcome.checkpoint?.at;
  const closed = logs.find(
    (row: any) =>
      row.at >= outcome.before?.at &&
      row.at < outcome.resumeSentAt &&
      row.message.includes("Client socket closed"),
  );
  return {
    mode: outcome.mode,
    checkpointAt: checkpoint,
    remoteSocketClosedAt: closed?.at ?? null,
    remoteSocketCloseMessage: closed?.message ?? null,
    secondsAfterCheckpoint:
      closed && checkpoint
        ? (Date.parse(closed.at) - Date.parse(checkpoint)) / 1000
        : null,
    resumeRequestedAt: outcome.resumeSentAt,
    querySucceeded:
      Boolean(outcome.after?.queryResult) && !outcome.after?.queryError,
    queryError: outcome.after?.queryError ?? null,
    sameModule: Boolean(
      outcome.before &&
        outcome.after &&
        outcome.before.moduleId === outcome.after.beforeQuery.moduleId,
    ),
    externalSamples: outcome.suspendedObservation?.samples,
    terminalStatus: outcome.terminal?.status,
    measured: Boolean(outcome.passed),
  };
});
const summary = {
  recordedAt: report.updatedAt,
  source: "Deployed Trigger.dev chat agent; Supavisor transaction mode",
  failures: report.failures,
  results,
  notes: [
    "Remote closure is null unless independently collected Supavisor logs identify it.",
    "Correlating project-wide pooler logs by time assumes a dedicated project and serial test cases.",
    "Node errors delivered after resume do not timestamp when the remote socket closed.",
    "Query failure is an intentional measured outcome for held clients and transactions.",
    "Raw traces, credentials, database contents, project identifiers and run IDs are omitted.",
  ],
};
const destination = path.replace(/\.json$/, "-summary.json");
if (destination === path) throw new Error("Input must have a .json extension");
writeFileSync(destination, JSON.stringify(summary, null, 2) + "\n");
console.table(
  results.map((row: any) => ({
    mode: row.mode,
    checkpoint: Boolean(row.checkpointAt),
    socketCloseSeconds: row.secondsAfterCheckpoint,
    querySucceeded: row.querySucceeded,
    status: row.terminalStatus,
  })),
);
console.log(destination);
