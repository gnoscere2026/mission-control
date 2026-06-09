import { eq } from "drizzle-orm";
import { users, type Db } from "@mission-control/db";

export interface Owner {
  id: string;
  email: string;
  displayName: string;
}

// Single-user deploy, multi-tenant shape: every job still runs against an
// explicit owner_id, resolved once at startup. Refusing to start without the
// seeded user is a loud failure, not a silent one (invariant 7).
export async function resolveOwner(db: Db): Promise<Owner> {
  const email = process.env.USER_EMAIL;
  if (!email) throw new Error("USER_EMAIL is not set — the worker cannot resolve its owner");
  const [row] = await db.select().from(users).where(eq(users.email, email));
  if (!row) {
    throw new Error(`no users row for USER_EMAIL=${email} — run \`npm run db:seed\` first`);
  }
  return { id: row.id, email: row.email, displayName: row.displayName };
}
