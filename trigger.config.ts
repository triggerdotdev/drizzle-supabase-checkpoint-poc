import { existsSync } from "node:fs";
import { defineConfig } from "@trigger.dev/sdk";

if (existsSync(".env")) process.loadEnvFile(".env");
// The CLI uses the local project ref. This config is also imported while indexing
// the deployment, where the local .env is absent and project selection is already done.
const project = process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me";

export default defineConfig({
  project,
  runtime: "node-24",
  dirs: ["./src/trigger"],
  maxDuration: 180,
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
});
