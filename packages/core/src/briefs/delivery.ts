import { and, eq, isNull } from "drizzle-orm";
import { briefs, type Db } from "@mission-control/db";

// Brief lifecycle columns transition exactly once (invariant 2): the isNull
// guard makes repeat delivery attempts a no-op on the timestamp.

export async function markBriefEmailed(db: Db, ownerId: string, briefId: string): Promise<void> {
  await db
    .update(briefs)
    .set({ emailedAt: new Date() })
    .where(and(eq(briefs.ownerId, ownerId), eq(briefs.id, briefId), isNull(briefs.emailedAt)));
}

export async function markBriefPushed(db: Db, ownerId: string, briefId: string): Promise<void> {
  await db
    .update(briefs)
    .set({ pushedAt: new Date() })
    .where(and(eq(briefs.ownerId, ownerId), eq(briefs.id, briefId), isNull(briefs.pushedAt)));
}

export async function markBriefOpened(db: Db, ownerId: string, briefId: string): Promise<boolean> {
  const rows = await db
    .update(briefs)
    .set({ openedAt: new Date() })
    .where(and(eq(briefs.ownerId, ownerId), eq(briefs.id, briefId), isNull(briefs.openedAt)))
    .returning({ id: briefs.id });
  return rows.length > 0;
}

export async function getBriefForDelivery(db: Db, ownerId: string, briefId: string) {
  const [row] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.ownerId, ownerId), eq(briefs.id, briefId)));
  return row;
}
