import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { commitments, people, type Db } from "@mission-control/db";

// Every surface filters snooze the same way: hidden until snoozed_until
// passes, woken by the WHERE clause alone.
const awake = or(isNull(commitments.snoozedUntil), lte(commitments.snoozedUntil, sql`now()`));

export interface CandidateRow {
  id: string;
  description: string;
  direction: string;
  confidence: number | null;
  dueDate: string | null;
  sourceType: string;
  sourceExcerpt: string | null;
  sourceEpisodeId: string | null;
  createdAt: Date;
  personName: string | null;
}

// Confirmation queue: candidates newest-first (MC-105).
export async function listCandidates(db: Db, ownerId: string): Promise<CandidateRow[]> {
  return db
    .select({
      id: commitments.id,
      description: commitments.description,
      direction: commitments.direction,
      confidence: commitments.confidence,
      dueDate: commitments.dueDate,
      sourceType: commitments.sourceType,
      sourceExcerpt: commitments.sourceExcerpt,
      sourceEpisodeId: commitments.sourceEpisodeId,
      createdAt: commitments.createdAt,
      personName: people.displayName,
    })
    .from(commitments)
    .leftJoin(people, eq(commitments.counterpartyPersonId, people.id))
    .where(and(eq(commitments.ownerId, ownerId), eq(commitments.status, "candidate"), awake))
    .orderBy(desc(commitments.createdAt));
}

export type LedgerView = "open" | "owed_to_me" | "snoozed";

// Ledger views (MC-105): open / owed-to-me are awake non-terminal commitments
// ranked by due date then age; snoozed is the predicate slice, any status.
export async function listLedger(db: Db, ownerId: string, view: LedgerView) {
  const base = {
    id: commitments.id,
    description: commitments.description,
    direction: commitments.direction,
    status: commitments.status,
    dueDate: commitments.dueDate,
    snoozedUntil: commitments.snoozedUntil,
    confidence: commitments.confidence,
    sourceType: commitments.sourceType,
    createdAt: commitments.createdAt,
    personName: people.displayName,
  };
  const q = db.select(base).from(commitments).leftJoin(people, eq(commitments.counterpartyPersonId, people.id));

  if (view === "snoozed") {
    return q
      .where(
        and(
          eq(commitments.ownerId, ownerId),
          inArray(commitments.status, ["candidate", "open"]),
          gt(commitments.snoozedUntil, sql`now()`),
        ),
      )
      .orderBy(asc(commitments.snoozedUntil));
  }

  return q
    .where(
      and(
        eq(commitments.ownerId, ownerId),
        eq(commitments.status, "open"),
        ...(view === "owed_to_me" ? [eq(commitments.direction, "owed_to_me")] : []),
        awake,
      ),
    )
    .orderBy(sql`${commitments.dueDate} asc nulls last`, asc(commitments.createdAt));
}
