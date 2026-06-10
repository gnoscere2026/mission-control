import { userActions, type Db } from "@mission-control/db";

// user_actions is strictly insert-only (invariant 2). Every disposition,
// capture, connect/disconnect, and brief-open goes through this one writer.
export interface AppendUserActionArgs {
  ownerId: string;
  action: string; // commitment_confirmed | google_connected | capture_submitted | …
  entityType?: string;
  entityId?: string;
  payload?: unknown;
}

export async function appendUserAction(db: Db, args: AppendUserActionArgs): Promise<string> {
  const [row] = await db
    .insert(userActions)
    .values({
      ownerId: args.ownerId,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      ...(args.payload !== undefined ? { payload: args.payload } : {}),
    })
    .returning({ id: userActions.id });
  if (!row) throw new Error("appendUserAction: insert returned no row");
  return row.id;
}
