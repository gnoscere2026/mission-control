import { describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { createDb } from "./client";
import { databaseUrl } from "./env";
import { runMigrations } from "./migrations";
import { seedUser } from "./seeding";
import { users } from "./schema";

// Integration tests: need Postgres (docker compose locally, service container in CI).
const url = databaseUrl();

describe("migrations + seed", () => {
  it("applies migrations and is a no-op on re-run", async () => {
    await runMigrations(url); // CI service container is clean → this is the fresh-apply check
    await runMigrations(url); // journal-tracked → no-op

    const { db, pool } = createDb(url);
    try {
      // schema is queryable after migrate
      const rows = await db.select().from(users).limit(0);
      expect(rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("seed is idempotent", async () => {
    const email = "seed-test@example.com";
    await seedUser(url, { email, displayName: "Seed Test" });
    await seedUser(url, { email, displayName: "Seed Test" });

    const { db, pool } = createDb(url);
    try {
      const [row] = await db.select({ n: count() }).from(users).where(eq(users.email, email));
      expect(row?.n).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
