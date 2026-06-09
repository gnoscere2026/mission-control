import { and, eq, sql } from "drizzle-orm";
import { people, type Db } from "@mission-control/db";

export interface ParsedAddress {
  email: string;
  name?: string;
}

// "Dana Reyes <dana@x.com>" | '"Reyes, Dana" <dana@x.com>' | "dana@x.com"
export function parseAddress(header: string): ParsedAddress {
  const m = header.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[2]) {
    const name = m[1]?.trim();
    return { email: m[2].trim().toLowerCase(), ...(name ? { name } : {}) };
  }
  return { email: header.trim().toLowerCase() };
}

// Relationship-lite person resolution during ingest (MC-102): match on email,
// auto-create on miss, keep last_contact_at fresh, never move it backwards.
export async function resolvePerson(
  db: Db,
  ownerId: string,
  addr: ParsedAddress,
  occurredAt: Date,
): Promise<string> {
  const email = addr.email.toLowerCase();
  const [existing] = await db
    .select()
    .from(people)
    .where(and(eq(people.ownerId, ownerId), sql`${people.emails} @> ARRAY[${email}]::text[]`));

  if (existing) {
    const localpart = email.split("@")[0]!;
    const wantsNameBackfill =
      addr.name !== undefined && addr.name !== "" && existing.displayName === localpart;
    const wantsContactBump =
      existing.lastContactAt === null || existing.lastContactAt < occurredAt;
    if (wantsNameBackfill || wantsContactBump) {
      await db
        .update(people)
        .set({
          ...(wantsNameBackfill ? { displayName: addr.name } : {}),
          ...(wantsContactBump ? { lastContactAt: occurredAt } : {}),
          updatedAt: new Date(),
        })
        .where(eq(people.id, existing.id));
    }
    return existing.id;
  }

  const [created] = await db
    .insert(people)
    .values({
      ownerId,
      displayName: addr.name?.trim() || email.split("@")[0]!,
      emails: [email],
      lastContactAt: occurredAt,
    })
    .returning({ id: people.id });
  if (!created) throw new Error("person insert returned no row");
  return created.id;
}
