import { and, eq } from "drizzle-orm";
import { googleAccounts, type Db } from "@mission-control/db";
import { sealToken } from "../crypto";
import { GOOGLE_SCOPES, type GoogleTokens } from "./oauth";

// Connect and re-consent share this path: tokens + status are replaced, sync
// cursors are deliberately untouched so a weekly re-consent (R2) never
// re-triggers the 30-day backfill.
export async function upsertGoogleAccount(
  db: Db,
  args: { ownerId: string; email: string; tokens: GoogleTokens; sealKey?: string },
): Promise<string> {
  const encryptedTokens = await sealToken(JSON.stringify(args.tokens), args.sealKey);
  const [row] = await db
    .insert(googleAccounts)
    .values({
      ownerId: args.ownerId,
      email: args.email,
      encryptedTokens,
      scopes: [...GOOGLE_SCOPES],
      status: "active",
    })
    .onConflictDoUpdate({
      target: [googleAccounts.ownerId, googleAccounts.email],
      set: { encryptedTokens, scopes: [...GOOGLE_SCOPES], status: "active", updatedAt: new Date() },
    })
    .returning({ id: googleAccounts.id });
  if (!row) throw new Error("google account upsert returned no row");
  return row.id;
}

export async function getGoogleAccount(db: Db, ownerId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(googleAccounts)
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));
  return row;
}

export async function listGoogleAccounts(db: Db, ownerId: string) {
  return db.select().from(googleAccounts).where(eq(googleAccounts.ownerId, ownerId));
}

export async function listActiveGoogleAccounts(db: Db, ownerId: string) {
  return db
    .select()
    .from(googleAccounts)
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.status, "active")));
}

export async function deleteGoogleAccount(db: Db, ownerId: string, accountId: string) {
  await db
    .delete(googleAccounts)
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));
}

export async function markReauthRequired(db: Db, ownerId: string, accountId: string) {
  await db
    .update(googleAccounts)
    .set({ status: "reauth_required", updatedAt: new Date() })
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));
}
