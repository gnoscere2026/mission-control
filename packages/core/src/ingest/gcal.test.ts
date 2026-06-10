import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sodium from "libsodium-wrappers";
import {
  calendarEvents,
  createDb,
  episodes,
  googleAccounts,
  people,
  users,
  type Db,
} from "@mission-control/db";
import { upsertGoogleAccount } from "../google/accounts";
import { GOOGLE_SCOPES } from "../google/oauth";
import {
  GcalSyncTokenExpiredError,
  type GcalClient,
  type GcalEvent,
  type GcalEventsPage,
} from "./gcal-client";
import { syncGcal } from "./gcal";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "gcal-sync-test@example.com";
const NOW = new Date("2026-06-08T15:00:00Z");

let db: Db;
let ownerId: string;
let accountId: string;
let sealKey: string;

function event(id: string, updated: string, overrides: Partial<GcalEvent> = {}): GcalEvent {
  return {
    id,
    status: "confirmed",
    updated,
    summary: `Meeting ${id}`,
    start: { dateTime: "2026-06-10T16:00:00Z" },
    end: { dateTime: "2026-06-10T17:00:00Z" },
    attendees: [
      { email: OWNER_EMAIL, self: true },
      { email: "dana@acme.example", displayName: "Dana Reyes" },
    ],
    raw: {},
    ...overrides,
  };
}

class FakeGcal implements GcalClient {
  pages: GcalEventsPage[] = [];
  expireToken = false;

  async listEvents(args: { syncToken?: string; timeMin?: string; pageToken?: string }) {
    if (args.syncToken && this.expireToken) throw new GcalSyncTokenExpiredError("410");
    const idx = args.pageToken ? Number(args.pageToken) : 0;
    return this.pages[idx]!;
  }
}

beforeAll(async () => {
  ({ db } = createDb(url));
  await sodium.ready;
  sealKey = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
  await db
    .insert(users)
    .values({ email: OWNER_EMAIL, displayName: "GCal Sync Test" })
    .onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(episodes).where(eq(episodes.ownerId, ownerId));
  await db.delete(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
  await db.delete(people).where(eq(people.ownerId, ownerId));
  await db.delete(googleAccounts).where(eq(googleAccounts.ownerId, ownerId));
  accountId = await upsertGoogleAccount(db, {
    ownerId,
    email: OWNER_EMAIL,
    tokens: {
      access_token: "at",
      refresh_token: "rt",
      expiry_date: Date.now() + 3_600_000,
      token_type: "Bearer",
      scope: GOOGLE_SCOPES.join(" "),
    },
    sealKey,
  });
});

async function setSyncToken(token: string) {
  await db
    .update(googleAccounts)
    .set({ gcalSyncToken: token, gcalLastSyncAt: new Date("2026-06-08T14:30:00Z") })
    .where(eq(googleAccounts.id, accountId));
}

describe("syncGcal", () => {
  it("initial sync writes events, episodes, resolved attendees, and the sync token", async () => {
    const client = new FakeGcal();
    client.pages = [{ items: [event("ev1", "2026-06-08T10:00:00Z")], nextSyncToken: "tok-1" }];

    const result = await syncGcal(db, ownerId, accountId, { client, now: NOW });

    expect(result.mode).toBe("initial_backfill");
    const events = await db.select().from(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("Meeting ev1");
    expect(events[0]!.status).toBe("confirmed");
    const attendees = events[0]!.attendees as { email: string; personId?: string }[];
    expect(attendees.find((a) => a.email === "dana@acme.example")?.personId).toBeTruthy();

    const eps = await db.select().from(episodes).where(eq(episodes.ownerId, ownerId));
    expect(eps).toHaveLength(1);
    expect(eps[0]!.source).toBe("gcal");

    const ppl = await db.select().from(people).where(eq(people.ownerId, ownerId));
    expect(ppl).toHaveLength(1); // self attendee skipped

    const [acct] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(acct!.gcalSyncToken).toBe("tok-1");
  });

  it("a moved event updates the row and writes a second episode", async () => {
    const client = new FakeGcal();
    client.pages = [{ items: [event("ev2", "2026-06-08T10:00:00Z")], nextSyncToken: "tok-1" }];
    await syncGcal(db, ownerId, accountId, { client, now: NOW });

    await setSyncToken("tok-1");
    client.pages = [
      {
        items: [
          event("ev2", "2026-06-08T12:00:00Z", { start: { dateTime: "2026-06-11T16:00:00Z" } }),
        ],
        nextSyncToken: "tok-2",
      },
    ];
    const result = await syncGcal(db, ownerId, accountId, { client, now: NOW });

    expect(result.mode).toBe("incremental");
    const events = await db.select().from(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
    expect(events).toHaveLength(1);
    expect(events[0]!.startsAt.toISOString()).toBe("2026-06-11T16:00:00.000Z");
    const eps = await db.select().from(episodes).where(eq(episodes.ownerId, ownerId));
    expect(eps).toHaveLength(2);
  });

  it("cancellation flips status without inserting a phantom event", async () => {
    const client = new FakeGcal();
    client.pages = [{ items: [event("ev3", "2026-06-08T10:00:00Z")], nextSyncToken: "tok-1" }];
    await syncGcal(db, ownerId, accountId, { client, now: NOW });

    await setSyncToken("tok-1");
    client.pages = [
      {
        items: [
          { id: "ev3", status: "cancelled", updated: "2026-06-08T13:00:00Z", raw: {} },
          { id: "never-seen", status: "cancelled", updated: "2026-06-08T13:00:00Z", raw: {} },
        ],
        nextSyncToken: "tok-2",
      },
    ];
    await syncGcal(db, ownerId, accountId, { client, now: NOW });

    const events = await db.select().from(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("cancelled");
  });

  it("expired sync token falls back to a full resync that converges", async () => {
    const client = new FakeGcal();
    client.pages = [{ items: [event("ev4", "2026-06-08T10:00:00Z")], nextSyncToken: "tok-1" }];
    await syncGcal(db, ownerId, accountId, { client, now: NOW });

    await setSyncToken("tok-1");
    client.expireToken = true;
    client.pages = [{ items: [event("ev4", "2026-06-08T10:00:00Z")], nextSyncToken: "tok-3" }];
    const result = await syncGcal(db, ownerId, accountId, { client, now: NOW });

    expect(result.mode).toBe("token_reset");
    const events = await db.select().from(calendarEvents).where(eq(calendarEvents.ownerId, ownerId));
    expect(events).toHaveLength(1); // upsert converged, no dup
    const eps = await db.select().from(episodes).where(eq(episodes.ownerId, ownerId));
    expect(eps).toHaveLength(1); // identical updated stamp → no second episode
    const [acct] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(acct!.gcalSyncToken).toBe("tok-3");
  });
});
