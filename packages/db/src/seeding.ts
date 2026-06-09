import { users } from "./schema";
import { createDb } from "./client";

// Idempotent single-user seed (CLAUDE.md): conflict on email is a no-op.
export async function seedUser(
  connectionString: string,
  args: { email: string; displayName: string },
): Promise<void> {
  const { db, pool } = createDb(connectionString);
  try {
    await db
      .insert(users)
      .values({ email: args.email, displayName: args.displayName })
      .onConflictDoNothing({ target: users.email });
  } finally {
    await pool.end();
  }
}
