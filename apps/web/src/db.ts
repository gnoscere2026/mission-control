import { createDb, type Db } from "@mission-control/db";

// One pool per server process. There is deliberately NO ownerless query helper
// here — all data access goes through src/queries.ts, where every function's
// first argument is ownerId (CLAUDE.md invariant 1).
let cached: ReturnType<typeof createDb> | undefined;

export function getDb(): Db {
  if (!cached) {
    const url =
      process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";
    cached = createDb(url);
  }
  return cached.db;
}
