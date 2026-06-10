import { and, eq } from "drizzle-orm";
import { calendarEvents, episodes, googleAccounts, type Db } from "@mission-control/db";
import { GcalSyncTokenExpiredError, type GcalClient, type GcalEvent } from "./gcal-client";
import { resolvePerson } from "./people";

// GCal incremental sync (MC-103): calendar_events upsert on gcal_event_id plus
// an episode per new/changed event (raw_ref "<id>@<updated>" — replay converges).
// Deliberately NO extraction enqueue in Phase 1: calendar chatter is the R3
// noise source and MC-103 omits it; the episodes still feed prep briefs and
// reconciliation later.

const BACKFILL_DAYS = 30;

export interface GcalSyncDeps {
  client: GcalClient;
  now?: Date;
}

export interface GcalSyncResult {
  mode: "initial_backfill" | "incremental" | "token_reset";
  eventsSeen: number;
  newEpisodeIds: string[];
}

export async function syncGcal(
  db: Db,
  ownerId: string,
  accountId: string,
  deps: GcalSyncDeps,
): Promise<GcalSyncResult> {
  const { client } = deps;
  const now = deps.now ?? new Date();

  const [account] = await db
    .select()
    .from(googleAccounts)
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));
  if (!account) throw new Error(`google account ${accountId} not found for owner`);

  const timeMin = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  let mode: GcalSyncResult["mode"] = account.gcalSyncToken ? "incremental" : "initial_backfill";

  async function listAll(args: { syncToken?: string; timeMin?: string }) {
    const items: GcalEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    do {
      const page = await client.listEvents({ ...args, pageToken });
      items.push(...page.items);
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  let listed: { items: GcalEvent[]; nextSyncToken?: string };
  if (mode === "incremental") {
    try {
      listed = await listAll({ syncToken: account.gcalSyncToken! });
    } catch (err) {
      if (!(err instanceof GcalSyncTokenExpiredError)) throw err;
      mode = "token_reset";
      listed = await listAll({ timeMin });
    }
  } else {
    listed = await listAll({ timeMin });
  }

  const ownerEmail = account.email.toLowerCase();
  const newEpisodeIds: string[] = [];

  for (const ev of listed.items) {
    const [existing] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.ownerId, ownerId), eq(calendarEvents.gcalEventId, ev.id)));

    if (ev.status === "cancelled") {
      // cancelled deltas carry no start/title; only flip rows we know about
      if (!existing || existing.status === "cancelled") continue;
      await db
        .update(calendarEvents)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(calendarEvents.id, existing.id));
      const epId = await insertEventEpisode(db, ownerId, ev, "cancelled", [], existing.title);
      if (epId) newEpisodeIds.push(epId);
      continue;
    }

    const startsAtRaw = ev.start?.dateTime ?? ev.start?.date;
    if (!startsAtRaw) continue; // unschedulable payload; nothing to track
    const startsAt = new Date(startsAtRaw);
    const endsAtRaw = ev.end?.dateTime ?? ev.end?.date;

    const personIds: string[] = [];
    const attendees: { email: string; displayName?: string; personId?: string }[] = [];
    for (const a of ev.attendees ?? []) {
      if (!a.email) continue;
      if (a.self || a.email.toLowerCase() === ownerEmail) continue;
      const personId = await resolvePerson(
        db,
        ownerId,
        { email: a.email, ...(a.displayName ? { name: a.displayName } : {}) },
        startsAt < now ? startsAt : now, // future meetings don't count as contact yet
      );
      personIds.push(personId);
      attendees.push({ email: a.email, displayName: a.displayName, personId });
    }

    const changed = existing !== undefined && extractUpdated(existing.raw) !== ev.updated;
    if (!existing) {
      await db.insert(calendarEvents).values({
        ownerId,
        gcalEventId: ev.id,
        title: ev.summary,
        startsAt,
        endsAt: endsAtRaw ? new Date(endsAtRaw) : undefined,
        attendees,
        status: "confirmed",
        raw: { updated: ev.updated, event: ev.raw },
      });
    } else if (changed || existing.status === "cancelled") {
      await db
        .update(calendarEvents)
        .set({
          title: ev.summary,
          startsAt,
          endsAt: endsAtRaw ? new Date(endsAtRaw) : null,
          attendees,
          status: "confirmed",
          raw: { updated: ev.updated, event: ev.raw },
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, existing.id));
    }

    if (!existing || changed) {
      const epId = await insertEventEpisode(
        db,
        ownerId,
        ev,
        existing ? "updated" : "created",
        personIds,
        ev.summary,
      );
      if (epId) newEpisodeIds.push(epId);
    }
  }

  await db
    .update(googleAccounts)
    .set({
      ...(listed.nextSyncToken ? { gcalSyncToken: listed.nextSyncToken } : {}),
      gcalLastSyncAt: now,
      updatedAt: new Date(),
    })
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));

  return { mode, eventsSeen: listed.items.length, newEpisodeIds };
}

function extractUpdated(raw: unknown): string | undefined {
  return (raw as { updated?: string } | null)?.updated;
}

async function insertEventEpisode(
  db: Db,
  ownerId: string,
  ev: GcalEvent,
  action: "created" | "updated" | "cancelled",
  relatedPersonIds: string[],
  title: string | null | undefined,
): Promise<string | undefined> {
  const [inserted] = await db
    .insert(episodes)
    .values({
      ownerId,
      occurredAt: ev.updated ? new Date(ev.updated) : new Date(),
      type: "event_synced",
      source: "gcal",
      summary: `${title ?? ev.id} (${action})`,
      rawRef: `${ev.id}@${ev.updated}`,
      payload: { gcalEventId: ev.id, action, start: ev.start, end: ev.end },
      relatedPersonIds,
    })
    .onConflictDoNothing()
    .returning({ id: episodes.id });
  return inserted?.id;
}
