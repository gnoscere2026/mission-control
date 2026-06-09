import { and, desc, eq } from "drizzle-orm";
import { briefs, cadenceRuns, users, type Db } from "@mission-control/db";

// Every helper takes ownerId — no ownerless query path exists (invariant 1).

export async function findUserByEmail(db: Db, email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row;
}

export async function listBriefs(db: Db, ownerId: string, limit = 50) {
  return db
    .select({
      id: briefs.id,
      kind: briefs.kind,
      dedupeKey: briefs.dedupeKey,
      generatedAt: briefs.generatedAt,
      openedAt: briefs.openedAt,
      pushedAt: briefs.pushedAt,
      emailedAt: briefs.emailedAt,
    })
    .from(briefs)
    .where(eq(briefs.ownerId, ownerId))
    .orderBy(desc(briefs.generatedAt))
    .limit(limit);
}

export async function getBrief(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.ownerId, ownerId), eq(briefs.id, id)));
  return row;
}

export async function listRecentRuns(db: Db, ownerId: string, limit = 50) {
  return db
    .select()
    .from(cadenceRuns)
    .where(eq(cadenceRuns.ownerId, ownerId))
    .orderBy(desc(cadenceRuns.startedAt))
    .limit(limit);
}
