import { and, eq } from "drizzle-orm";
import { commitments, extractionLabels, type Db } from "@mission-control/db";
import { appendUserAction } from "../activity/user-actions";

// Invariant 5 (CLAUDE.md): commitment state advances ONLY through these
// functions, each driven by an explicit user disposition. Every disposition
// writes user_actions; queue dispositions on extraction-produced candidates
// also write extraction_labels (the eval harness's production signal).

async function getOwned(db: Db, ownerId: string, commitmentId: string) {
  const [row] = await db
    .select()
    .from(commitments)
    .where(and(eq(commitments.ownerId, ownerId), eq(commitments.id, commitmentId)));
  if (!row) throw new Error(`commitment ${commitmentId} not found for owner`);
  return row;
}

async function writeLabel(
  db: Db,
  args: {
    ownerId: string;
    commitmentId: string;
    sourceEpisodeId: string | null;
    label: "confirmed" | "edited" | "rejected";
    promptVersion: string | null;
    editedFields?: unknown;
  },
) {
  await db.insert(extractionLabels).values({
    ownerId: args.ownerId,
    commitmentId: args.commitmentId,
    sourceEpisodeId: args.sourceEpisodeId,
    label: args.label,
    promptVersion: args.promptVersion ?? "unknown",
    ...(args.editedFields !== undefined ? { editedFields: args.editedFields } : {}),
  });
}

export interface DispositionArgs {
  ownerId: string;
  commitmentId: string;
}

export async function confirmCommitment(db: Db, args: DispositionArgs): Promise<void> {
  const row = await getOwned(db, args.ownerId, args.commitmentId);
  if (row.status !== "candidate") {
    throw new Error(`commitment ${args.commitmentId} is not a candidate (status=${row.status})`);
  }
  await db
    .update(commitments)
    .set({ status: "open", confirmedAt: new Date() })
    .where(and(eq(commitments.id, row.id), eq(commitments.status, "candidate")));
  await appendUserAction(db, {
    ownerId: args.ownerId,
    action: "commitment_confirmed",
    entityType: "commitment",
    entityId: row.id,
  });
  await writeLabel(db, {
    ownerId: args.ownerId,
    commitmentId: row.id,
    sourceEpisodeId: row.sourceEpisodeId,
    label: "confirmed",
    promptVersion: row.promptVersion,
  });
}

export async function rejectCommitment(db: Db, args: DispositionArgs): Promise<void> {
  const row = await getOwned(db, args.ownerId, args.commitmentId);
  if (row.status !== "candidate") {
    throw new Error(`commitment ${args.commitmentId} is not a candidate (status=${row.status})`);
  }
  await db
    .update(commitments)
    .set({ status: "dropped", resolvedAt: new Date() })
    .where(and(eq(commitments.id, row.id), eq(commitments.status, "candidate")));
  await appendUserAction(db, {
    ownerId: args.ownerId,
    action: "commitment_rejected",
    entityType: "commitment",
    entityId: row.id,
  });
  await writeLabel(db, {
    ownerId: args.ownerId,
    commitmentId: row.id,
    sourceEpisodeId: row.sourceEpisodeId,
    label: "rejected",
    promptVersion: row.promptVersion,
  });
}

export interface CommitmentEdits {
  description?: string;
  direction?: "owed_by_me" | "owed_to_me";
  dueDate?: string | null; // YYYY-MM-DD
  dueDateBasis?: "explicit" | "inferred" | null;
  counterpartyPersonId?: string | null;
}

export async function editAndConfirmCommitment(
  db: Db,
  args: DispositionArgs & { edits: CommitmentEdits },
): Promise<void> {
  const row = await getOwned(db, args.ownerId, args.commitmentId);
  if (row.status !== "candidate") {
    throw new Error(`commitment ${args.commitmentId} is not a candidate (status=${row.status})`);
  }

  const current: Record<string, unknown> = {
    description: row.description,
    direction: row.direction,
    dueDate: row.dueDate,
    dueDateBasis: row.dueDateBasis,
    counterpartyPersonId: row.counterpartyPersonId,
  };
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, to] of Object.entries(args.edits)) {
    if (to !== undefined && current[field] !== to) diff[field] = { from: current[field], to };
  }

  await db
    .update(commitments)
    .set({
      ...(args.edits.description !== undefined ? { description: args.edits.description } : {}),
      ...(args.edits.direction !== undefined ? { direction: args.edits.direction } : {}),
      ...(args.edits.dueDate !== undefined ? { dueDate: args.edits.dueDate } : {}),
      ...(args.edits.dueDateBasis !== undefined ? { dueDateBasis: args.edits.dueDateBasis } : {}),
      ...(args.edits.counterpartyPersonId !== undefined
        ? { counterpartyPersonId: args.edits.counterpartyPersonId }
        : {}),
      status: "open",
      confirmedAt: new Date(),
    })
    .where(and(eq(commitments.id, row.id), eq(commitments.status, "candidate")));

  await appendUserAction(db, {
    ownerId: args.ownerId,
    action: "commitment_edited",
    entityType: "commitment",
    entityId: row.id,
    payload: diff,
  });
  await writeLabel(db, {
    ownerId: args.ownerId,
    commitmentId: row.id,
    sourceEpisodeId: row.sourceEpisodeId,
    label: "edited",
    promptVersion: row.promptVersion,
    editedFields: diff,
  });
}

// Snooze is a predicate, not a status (SCHEMA §2.2): only snoozed_until moves;
// waking is a WHERE clause, so invariant 5 stays exact. No label — snoozing
// says nothing about extraction quality.
export async function snoozeCommitment(
  db: Db,
  args: DispositionArgs & { until: Date },
): Promise<void> {
  const row = await getOwned(db, args.ownerId, args.commitmentId);
  await db
    .update(commitments)
    .set({ snoozedUntil: args.until })
    .where(eq(commitments.id, row.id));
  await appendUserAction(db, {
    ownerId: args.ownerId,
    action: "commitment_snoozed",
    entityType: "commitment",
    entityId: row.id,
    payload: { until: args.until.toISOString() },
  });
}

export interface ManualCommitmentArgs {
  ownerId: string;
  direction: "owed_by_me" | "owed_to_me";
  description: string;
  counterpartyPersonId?: string | null;
  dueDate?: string | null;
}

// Manual adds skip candidate state — the user asserting a commitment IS the
// disposition (MC-105 AC).
export async function addManualCommitment(db: Db, args: ManualCommitmentArgs): Promise<string> {
  const [row] = await db
    .insert(commitments)
    .values({
      ownerId: args.ownerId,
      direction: args.direction,
      description: args.description,
      sourceType: "manual",
      counterpartyPersonId: args.counterpartyPersonId ?? null,
      dueDate: args.dueDate ?? null,
      dueDateBasis: args.dueDate ? "explicit" : null,
      status: "open",
      confirmedAt: new Date(),
    })
    .returning({ id: commitments.id });
  if (!row) throw new Error("manual commitment insert returned no row");
  await appendUserAction(db, {
    ownerId: args.ownerId,
    action: "commitment_added",
    entityType: "commitment",
    entityId: row.id,
  });
  return row.id;
}
