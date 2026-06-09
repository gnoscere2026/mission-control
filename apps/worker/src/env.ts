import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// The shared .env lives at repo root; cwd is apps/worker when run via npm -w.
export function loadEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.join(here, "..", "..", "..", ".env") });
  dotenv.config();
}

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";
}

export function redisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}
