import type { PoolConfig } from "pg";

export function connectionConfig(
  connectionString: string,
  applicationName: string,
): PoolConfig {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
    url.searchParams.delete(key);
  if (
    sslMode === "disable" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    throw new Error("This POC requires verified TLS for remote databases");
  }
  return {
    connectionString: url.toString(),
    ssl:
      sslMode === "disable"
        ? false
        : {
            rejectUnauthorized: true,
            ...(process.env.DATABASE_CA_PEM
              ? { ca: process.env.DATABASE_CA_PEM.replace(/\\n/g, "\n") }
              : {}),
          },
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  };
}
