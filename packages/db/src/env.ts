import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// CLI entrypoints run with cwd = the workspace dir; the shared .env lives at repo root.
export function loadEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.join(here, "..", "..", "..", ".env") });
  dotenv.config(); // also honor a cwd-local .env if present
}

export const LOCAL_DATABASE_URL = "postgres://postgres:postgres@localhost:5433/mission_control";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
}
