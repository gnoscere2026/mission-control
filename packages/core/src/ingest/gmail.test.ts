import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import sodium from "libsodium-wrappers";
import {
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
  GmailHistoryGoneError,
  type GmailClient,
  type GmailHistoryPage,
  type GmailMessage,
} from "./gmail-client";
import { syncGmail } from "./gmail";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "gmail-sync-test@example.com";
const NOW = new Date("2026-06-08T15:00:00Z");

let db: Db;
let ownerId: string;
let accountId: string;
let sealKey: string;

function msg(id: string, from: string, subject: string, body: string): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: new Date("2026-06-08T14:00:00Z").getTime(),
    from,
    to: `Mark Test <${OWNER_EMAIL}>`,
    subject,
    snippet: body.slice(0, 80),
    bodyExcerpt: body,
  };
}

class FakeGmail implements GmailClient {
  profile = { emailAddress: OWNER_EMAIL, historyId: "9000" };
  historyPages: GmailHistoryPage[] | "gone" = [];
  messages = new Map<string, GmailMessage>();
  listedIds: string[] = [];
  getCalls = 0;

  async getProfile() {
    return this.profile;
  }
  async listHistory(_start: string, pageToken?: string): Promise<GmailHistoryPage> {
    if (this.historyPages === "gone") throw new GmailHistoryGoneError("history expired");
    const idx = pageToken ? Number(pageToken) : 0;
    return this.historyPages[idx]!;
  }
  async listMessageIds(_q: string, _pageToken?: string) {
    return { ids: this.listedIds, nextPageToken: undefined };
  }
  async getMessage(id: string): Promise<GmailMessage> {
    this.getCalls++;
    const m = this.messages.get(id);
    if (!m) throw new Error(`no fake message ${id}`);
    return m;
  }
}

beforeAll(async () => {
  ({ db } = createDb(url));
  await sodium.ready;
  sealKey = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
  await db
    .insert(users)
    .values({ email: OWNER_EMAIL, displayName: "Gmail Sync Test" })
    .onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(episodes).where(eq(episodes.ownerId, ownerId));
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

async function setCursor(historyId: string, lastSyncAt = new Date("2026-06-08T14:30:00Z")) {
  await db
    .update(googleAccounts)
    .set({ gmailHistoryId: historyId, gmailLastSyncAt: lastSyncAt })
    .where(eq(googleAccounts.id, accountId));
}

describe("syncGmail", () => {
  it("initial backfill: episodes + people written, NO extraction ids, cursor set from profile", async () => {
    const client = new FakeGmail();
    client.listedIds = ["m1", "m2"];
    client.messages.set("m1", msg("m1", "Dana Reyes <dana@acme.example>", "deck", "I'll send the deck Friday."));
    client.messages.set("m2", msg("m2", "Sam <sam@x.example>", "hi", "hello there"));

    const result = await syncGmail(db, ownerId, accountId, { client, now: NOW });

    expect(result.mode).toBe("initial_backfill");
    expect(result.newEpisodeIds).toHaveLength(2);
    expect(result.extractEpisodeIds).toHaveLength(0);

    const eps = await db.select().from(episodes).where(eq(episodes.ownerId, ownerId));
    expect(eps).toHaveLength(2);
    expect(eps[0]!.source).toBe("gmail");
    expect(eps[0]!.type).toBe("email_received");

    const ppl = await db.select().from(people).where(eq(people.ownerId, ownerId));
    expect(ppl.map((p) => p.displayName).sort()).toEqual(["Dana Reyes", "Sam"]);

    const [acct] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(acct!.gmailHistoryId).toBe("9000");
    expect(acct!.gmailLastSyncAt).not.toBeNull();
  });

  it("incremental: new messages become episodes AND extraction candidates; cursor advances", async () => {
    await setCursor("100");
    const client = new FakeGmail();
    client.historyPages = [{ historyId: "200", messageIds: ["m3"] }];
    client.messages.set("m3", msg("m3", "Dana <dana@acme.example>", "intro", "Can you intro me to Priya?"));

    const result = await syncGmail(db, ownerId, accountId, { client, now: NOW });

    expect(result.mode).toBe("incremental");
    expect(result.newEpisodeIds).toHaveLength(1);
    expect(result.extractEpisodeIds).toEqual(result.newEpisodeIds);
    const [acct] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(acct!.gmailHistoryId).toBe("200");
  });

  it("empty delta: zero rows, cursor still advances", async () => {
    await setCursor("100");
    const client = new FakeGmail();
    client.historyPages = [{ historyId: "150", messageIds: [] }];
    const result = await syncGmail(db, ownerId, accountId, { client, now: NOW });
    expect(result.newEpisodeIds).toHaveLength(0);
    const [acct] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(acct!.gmailHistoryId).toBe("150");
  });

  it("replaying the same window creates zero new rows and skips refetching bodies", async () => {
    await setCursor("100");
    const client = new FakeGmail();
    client.historyPages = [{ historyId: "200", messageIds: ["m4"] }];
    client.messages.set("m4", msg("m4", "Sam <sam@x.example>", "re", "got it"));

    const first = await syncGmail(db, ownerId, accountId, { client, now: NOW });
    expect(first.newEpisodeIds).toHaveLength(1);

    await setCursor("100"); // simulate a crashed run replaying the same history window
    const second = await syncGmail(db, ownerId, accountId, { client, now: NOW });
    expect(second.newEpisodeIds).toHaveLength(0);
    expect(second.extractEpisodeIds).toHaveLength(0);
    expect(client.getCalls).toBe(1); // existing raw_ref short-circuits the messages.get
  });

  it("404 cursor fallback: re-lists, extraction IS enqueued for new rows, cursor reset", async () => {
    await setCursor("100");
    const client = new FakeGmail();
    client.historyPages = "gone";
    client.listedIds = ["m5"];
    client.messages.set("m5", msg("m5", "Dana <dana@acme.example>", "follow-up", "I'll review by Tuesday."));

    const result = await syncGmail(db, ownerId, accountId, { client, now: NOW });

    expect(result.mode).toBe("cursor_fallback");
    expect(result.newEpisodeIds).toHaveLength(1);
    expect(result.extractEpisodeIds).toEqual(result.newEpisodeIds);
    const [acct] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(acct!.gmailHistoryId).toBe("9000"); // reset from profile
  });

  it("owner-sent mail resolves the recipient, not the owner, as the related person", async () => {
    await setCursor("100");
    const client = new FakeGmail();
    client.historyPages = [{ historyId: "300", messageIds: ["m6"] }];
    const m = msg("m6", `Mark Test <${OWNER_EMAIL}>`, "promise", "I'll send the contract Friday.");
    m.to = "Priya Kaur <priya@y.example>";
    client.messages.set("m6", m);

    await syncGmail(db, ownerId, accountId, { client, now: NOW });

    const ppl = await db.select().from(people).where(eq(people.ownerId, ownerId));
    expect(ppl).toHaveLength(1);
    expect(ppl[0]!.displayName).toBe("Priya Kaur");
  });

  it("same sender across messages converges on one person row", async () => {
    await setCursor("100");
    const client = new FakeGmail();
    client.historyPages = [{ historyId: "400", messageIds: ["m7", "m8"] }];
    client.messages.set("m7", msg("m7", "Dana <dana@acme.example>", "a", "one"));
    client.messages.set("m8", msg("m8", "Dana <dana@acme.example>", "b", "two"));

    await syncGmail(db, ownerId, accountId, { client, now: NOW });

    const ppl = await db
      .select()
      .from(people)
      .where(and(eq(people.ownerId, ownerId)));
    expect(ppl).toHaveLength(1);
  });
});
